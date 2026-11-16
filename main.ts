// main.ts — the trial entrypoint: start the forge behind its caching edge,
// register the edge's port with the suite, and exit when the suite is done.
//
// The trial contract, as the bounty states it: the program binds an
// ephemeral port of its own (never 8080, where the suite listens), POSTs
// {"port": <the port>} to $MAKEFUN_ENV_URL/register, and long-polls GET
// $MAKEFUN_ENV_URL/done until the suite answers {"done": true}, then exits
// 0. A program that exits, crashes, or never registers before the boot
// budget ends leaves no working forge and scores 0.
//
// The serving stack has two servers sharing one forge instance, so the
// store is single and the answers are consistent whichever server a request
// arrives on:
//
//   - the loopback server runs the forge's own request handler on
//     127.0.0.1 and an ephemeral port. Only the edge talks to it, for the
//     git POSTs whose bodies the edge reads before routing.
//   - the edge server listens on 0.0.0.0 and an ephemeral port and is the
//     port the suite is told about. It answers the forge's deterministic
//     requests from its caches and hands everything else to the forge's
//     handler in the same process.
//
// Registration retries until it lands (the suite may not be listening yet
// when the program starts), and the done poll retries through transient
// failures too: the trial ends when the suite says it is done, never
// because one poll failed. Nothing here writes to the filesystem, keeps a
// wall clock in any answer, or uses unseeded randomness: the forge's own
// timestamps come from the trial, and the edge only replays bytes the forge
// already produced.

import { createApp } from './app.ts';
import { createEdgeServer } from './edge.ts';

/** The suite's origin, from the trial environment. No trailing slash. */
function envUrl(): string {
  const raw = process.env.MAKEFUN_ENV_URL;
  if (raw === undefined || raw.trim() === '') {
    throw new Error('main: MAKEFUN_ENV_URL is not set');
  }
  return raw.trim().replace(/\/+$/, '');
}

/** POST {"port": n} to the suite's register endpoint, once, with a timeout. */
async function registerOnce(origin: string, port: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${origin}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
      signal: controller.signal,
    });
    await response.text().catch(() => '');
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Ask the suite whether the trial is done; false on any transport failure. */
async function pollDoneOnce(origin: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${origin}/done`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const body = (await response.json().catch(() => null)) as { done?: unknown } | null;
    return body !== null && body.done === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Listen on a server at an ephemeral port; resolves with the chosen port. */
function listenEphemeral(server: import('node:http').Server, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error(`main: the server did not bind a port on ${host}`));
        return;
      }
      resolve(address.port);
    });
  });
}

/** Sleep without blocking the loop: the poll and retry cadence live here. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const origin = envUrl();
  const app = createApp();
  const { server: edgeServer, loopback, edge } = createEdgeServer(app);

  // The loopback forge first: the edge forwards git POSTs to it, so it must
  // be listening before the edge takes traffic.
  const loopbackPort = await listenEphemeral(loopback, '127.0.0.1');
  edge.setLoopbackPort(loopbackPort);

  // The public port: 0 lets the kernel choose, on every interface, so the
  // address the suite dials back — the one this process registered from —
  // is one the edge listens on.
  const port = await listenEphemeral(edgeServer, '0.0.0.0');

  // Register, retrying every half second until the suite records the port.
  // The suite waits for this before its boot budget ends; a missed first
  // attempt (the suite still starting) must not end the trial.
  for (;;) {
    if (await registerOnce(origin, port)) break;
    await sleep(500);
  }

  // Poll until the suite has finished and written its export, then stop.
  // A failed poll is a retry, never a reason to exit: the suite answers
  // {"done": false} until it is finished, and the trial's wall budget is
  // the only clock that matters here.
  for (;;) {
    if (await pollDoneOnce(origin)) break;
    await sleep(250);
  }

  // One line of run evidence on stderr: what the edge served from cache.
  // The trial's exports are the suite's own; this line is only a local
  // diagnostic and never reaches a scored file.
  process.stderr.write(`[edge] ${JSON.stringify(edge.stats())}\n`);
  edgeServer.close();
  loopback.close();
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`main: fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
