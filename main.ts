// Entry point: a single-process GitHub-compatible git forge.
//
// Lifecycle (set by the trial harness):
//   1. listen on an ephemeral port
//   2. POST {port} to $MAKEFUN_ENV_URL/register so the suite can reach us
//   3. poll GET $MAKEFUN_ENV_URL/done until {done: true}, then exit 0
import { createApp } from './app.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url: string, payload: unknown): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForDone(): Promise<void> {
  for (;;) {
    try {
      const res = await fetch(`${ENV_URL}/done`);
      const data = (await res.json()) as { done?: boolean };
      if (data.done === true) return;
    } catch {
      // Harness not ready yet; keep polling.
    }
    await sleep(500);
  }
}

async function main(): Promise<void> {
  const app = createApp();
  await new Promise<void>((resolve) => {
    app.listen(0, () => resolve());
  });
  const address = app.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  if (ENV_URL !== '') {
    let registered = false;
    for (let attempt = 0; attempt < 60 && !registered; attempt += 1) {
      registered = await postJson(`${ENV_URL}/register`, { port });
      if (!registered) await sleep(500);
    }
    await waitForDone();
  } else {
    // No harness: stay up until killed (local smoke tests).
    await new Promise<void>(() => undefined);
  }
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
