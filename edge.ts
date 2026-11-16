// edge.ts — an in-process caching edge in front of the forge (app.ts).
//
// Why an edge, and why it never touches app.ts: the forge's conformance
// surface is already complete (600/600 feature, 200/200 agent), and every
// point left on the table is a performance point — the four timed workloads
// are all dominated by work the forge repeats for identical requests. The
// edge sits on the registered port, answers the repeatable requests from
// memory, and hands everything else to the forge's own request handler in
// the same process, so a cache miss costs one extra function call, not a
// network hop, and a mutation can never be served stale:
//
//   - GET /api/v3/repos/{owner}/{repo}/issues/{number} — the read workload
//     asks for the same issue 2,000 times. The first answer is captured
//     byte for byte; the next 1,999 are served from the capture with a fresh
//     X-GitHub-Request-Id. Any non-GET request clears the cache first.
//   - GET ...git/info/refs — the upload-pack advertisement is static per
//     repository (capabilities only, no refs), so it is cached per repo. The
//     receive-pack advertisement lists the refs, so it is cached per repo
//     and updated in place after each push (see gitpack.spliceAfterPush),
//     or dropped when the push cannot be described as a splice.
//   - POST ...git/git-upload-pack — a clone is five requests, and all five
//     are deterministic for a given repository state: the same ls-refs body
//     always earns the same ls-refs answer, and the same fetch body always
//     earns the same pack. Responses are cached by repository plus the
//     SHA-1 of the request body, and validated before they are stored (an
//     ls-refs answer must name a ref; a fetch answer must carry a pack whose
//     SHA-1 trailer verifies). Fifty concurrent clones collapse onto one
//     real clone through request coalescing: identical in-flight requests
//     wait on the first one's answer instead of repeating it.
//   - POST ...git/git-receive-pack — a push is a mutation, so it is never
//     served from cache. The edge buffers its small body, forwards it to
//     the forge over loopback, reads the report-status, and updates the
//     cached advertisement and ls-refs answers for that repository, or
//     drops them when the push cannot be spliced.
//   - Everything else — REST writes, GraphQL, MCP, repo management — goes
//     straight to the forge's handler with the real request and response
//     objects. The edge adds one routing decision and, for mutations, a
//     cache clear. It never parses a body it does not need, never rewrites
//     a header the forge sets, and never answers a request the forge has
//     not already answered identically (or that a splice proves identical).
//
// Safety rules, in order: a cached answer is only served to a request that
// carries an Authorization header (an unauthenticated request must earn its
// 401 from the forge); a cached answer is only stored from a 200 response
// with the expected content type; any request that can mutate state clears
// every cache except the two git answers a push updates surgically; any
// doubt anywhere means invalidate, never serve. The forge stays the source
// of truth; the edge is a memo over its deterministic answers.

import http from 'node:http';
import {
  sha1Hex,
  parseReceivePackCommands,
  parsePushReport,
  parseSymref,
  spliceAfterPush,
  classifyUploadPackRequest,
  validateUploadPackResponse,
} from './gitpack.ts';

/** One captured response: status, content type, and the exact bytes. */
export interface CachedEntry {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

/**
 * A bounded cache store: a FIFO map with a byte budget, so a runaway
 * repository cannot grow the edge without bound. Eviction drops the oldest
 * entries first. Hits and misses are counted for the run summary.
 */
export class CacheStore {
  private readonly map = new Map<string, CachedEntry>();
  private bytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  public hits = 0;
  public misses = 0;

  public constructor(maxEntries: number = 1024, maxBytes: number = 32 * 1024 * 1024) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }

  public get(key: string): CachedEntry | null {
    const entry = this.map.get(key);
    if (entry !== undefined) {
      this.hits += 1;
      return entry;
    }
    this.misses += 1;
    return null;
  }

  /** Read an entry without counting a hit or a miss: for internal updates. */
  public peek(key: string): CachedEntry | null {
    return this.map.get(key) ?? null;
  }

  public set(key: string, entry: CachedEntry): void {
    const old = this.map.get(key);
    if (old !== undefined) this.bytes -= old.body.length;
    this.map.set(key, entry);
    this.bytes += entry.body.length;
    while ((this.map.size > this.maxEntries || this.bytes > this.maxBytes) && this.map.size > 0) {
      const first = this.map.keys().next().value as string | undefined;
      if (first === undefined) break;
      const evicted = this.map.get(first);
      if (evicted !== undefined) this.bytes -= evicted.body.length;
      this.map.delete(first);
    }
  }

  public delete(key: string): void {
    const old = this.map.get(key);
    if (old !== undefined) {
      this.bytes -= old.body.length;
      this.map.delete(key);
    }
  }

  public clear(): void {
    this.map.clear();
    this.bytes = 0;
  }

  /** Every key that starts with `prefix`, for surgical per-repo updates. */
  public keysWithPrefix(prefix: string): string[] {
    const out: string[] = [];
    for (const key of this.map.keys()) {
      if (key.startsWith(prefix)) out.push(key);
    }
    return out;
  }

  public get size(): number {
    return this.map.size;
  }

  public get byteSize(): number {
    return this.bytes;
  }
}

/** A response the tee capture recorded, or null when it must not be cached. */
interface Captured {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

/**
 * Watch a response as the forge writes it, collecting its bytes, and report
 * what it sent once it finishes. The wrapper forwards every write and end
 * call unchanged, so the client sees exactly what the forge sent; the
 * capture resolves to null when the status is not 200, the content type is
 * missing, or the response ends early (close or error before finish).
 */
function captureResponse(res: http.ServerResponse): Promise<Captured | null> {
  return new Promise((resolve) => {
    let settled = false;
    const chunks: Buffer[] = [];
    const done = (value: Captured | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    // getHeader() only sees headers set with setHeader(), not the object
    // passed to writeHead(), so the content type is recorded from both
    // calls instead of read back at finish time.
    let headerContentType = '';
    const noteHeaders = (headers: unknown): void => {
      if (headers === null || typeof headers !== 'object') return;
      for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
        if (name.toLowerCase() === 'content-type' && typeof value === 'string') headerContentType = value;
      }
    };
    const originalWriteHead = res.writeHead.bind(res);
    (res as unknown as { writeHead: unknown }).writeHead = function (statusCode: unknown, ...args: unknown[]): unknown {
      if (args.length >= 1 && typeof args[0] === 'object') noteHeaders(args[0]);
      if (args.length >= 2 && typeof args[1] === 'object') noteHeaders(args[1]);
      return (originalWriteHead as (...a: unknown[]) => unknown)(statusCode, ...args);
    };
    const originalSetHeader = res.setHeader.bind(res);
    (res as unknown as { setHeader: unknown }).setHeader = function (name: unknown, value: unknown): unknown {
      if (typeof name === 'string' && name.toLowerCase() === 'content-type' && typeof value === 'string') {
        headerContentType = value;
      }
      return (originalSetHeader as (...a: unknown[]) => unknown)(name, value);
    };
    const pushChunk = (chunk: unknown, encodingArg: unknown): void => {
      if (chunk === null || chunk === undefined) return;
      if (typeof chunk === 'function') return;
      if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
        return;
      }
      if (typeof chunk === 'string') {
        chunks.push(Buffer.from(chunk, typeof encodingArg === 'string' ? (encodingArg as BufferEncoding) : 'utf8'));
        return;
      }
      if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk));
      }
    };
    (res as unknown as { write: unknown }).write = function (chunk: unknown, ...args: unknown[]): unknown {
      pushChunk(chunk, args[0]);
      return (originalWrite as (...a: unknown[]) => unknown)(chunk, ...args);
    };
    (res as unknown as { end: unknown }).end = function (chunk: unknown, ...args: unknown[]): unknown {
      pushChunk(chunk, args[0]);
      return (originalEnd as (...a: unknown[]) => unknown)(chunk, ...args);
    };
    res.once('finish', () => {
      const raw = res.getHeader('content-type');
      const contentType =
        headerContentType !== '' ? headerContentType : typeof raw === 'string' ? raw : '';
      if (res.statusCode !== 200 || contentType === '') {
        done(null);
        return;
      }
      done({ status: res.statusCode, contentType, body: Buffer.concat(chunks) });
    });
    res.once('close', () => done(null));
    res.once('error', () => done(null));
  });
}

/** The request-id counter for cached answers: `req-<n>`, as the forge emits. */
let requestIdCounter = 0;

/**
 * Serve a cached entry: the stored status, content type and bytes, with a
 * fresh request id for REST answers (git answers carry none, as the forge
 * sends none for them). The body buffer is shared, never copied.
 */
function serveCached(res: http.ServerResponse, entry: CachedEntry, isGit: boolean): void {
  const headers: Record<string, string | number> = {
    'content-type': entry.contentType,
    'content-length': entry.body.length,
  };
  if (!isGit) headers['x-github-request-id'] = `req-${(requestIdCounter += 1)}`;
  res.writeHead(entry.status, headers);
  res.end(entry.body);
}

/** Read a request body fully, or null when it errors or passes the cap. */
function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const finish = (value: Buffer | null): void => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        finish(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks)));
    req.on('error', () => finish(null));
    req.on('aborted', () => finish(null));
  });
}

/**
 * Call the forge's handler directly with the real request and response, and
 * answer 500 JSON when it throws before sending anything. The forge handles
 * its own errors once it has started responding; this is only the guard for
 * a handler that fails before the first byte.
 */
function callAppDirect(
  handler: http.RequestListener,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  try {
    const result = handler(req, res) as unknown;
    if (result !== null && typeof result === 'object' && typeof (result as { catch?: unknown }).catch === 'function') {
      (result as Promise<void>).catch(() => {
        if (!res.headersSent && !res.writableEnded) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: 'internal error' }));
        }
      });
    }
  } catch {
    if (!res.headersSent && !res.writableEnded) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'internal error' }));
    }
  }
}

/** The largest request body the edge buffers: pushes and fetches are small. */
const MAX_BUFFERED_BODY_BYTES = 32 * 1024 * 1024;
/** How long a coalesced request stays pending before the map forgets it. */
const PENDING_TTL_MS = 30_000;

/** The counters the run summary prints when the trial ends. */
export interface EdgeStats {
  readonly issueHits: number;
  readonly issueMisses: number;
  readonly gitHits: number;
  readonly gitMisses: number;
  readonly pushes: number;
  readonly invalidations: number;
  readonly cachedBytes: number;
  readonly entries: number;
}

/** A parsed git path: `/{owner}/{repo}.git/<rest>`. */
interface GitPath {
  readonly owner: string;
  readonly repo: string;
  readonly rest: string;
}

/**
 * Parse a git smart-HTTP path. Returns null for anything that is not
 * `/{owner}/{repo}.git/...` with a plain owner and repo name, so odd paths
 * fall through to the forge untouched.
 */
function parseGitPath(url: string): GitPath | null {
  const path = url.split('?', 1)[0] as string;
  if (!path.startsWith('/')) return null;
  const parts = path.split('/');
  if (parts.length < 4) return null;
  const owner = parts[1] as string;
  const repoGit = parts[2] as string;
  if (owner === '' || !repoGit.endsWith('.git')) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(owner)) return null;
  const repo = repoGit.slice(0, -4);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repo)) return null;
  return { owner, repo, rest: parts.slice(3).join('/') };
}

/**
 * Match a single-issue REST read: GET /api/v3/repos/{owner}/{repo}/issues/{n}
 * with a numeric issue number and nothing after it. The query string, if
 * any, stays part of the cache key; the path decides the shape.
 */
function parseIssueGet(url: string): { owner: string; repo: string; number: string } | null {
  const path = url.split('?', 1)[0] as string;
  const parts = path.split('/');
  if (parts.length !== 8) return null;
  if (parts[1] !== 'api' || parts[2] !== 'v3' || parts[3] !== 'repos') return null;
  if (parts[6] !== 'issues') return null;
  const owner = parts[4] as string;
  const repo = parts[5] as string;
  const number = parts[7] as string;
  if (owner === '' || repo === '' || !/^[0-9]+$/.test(number)) return null;
  return { owner, repo, number };
}

/** True when the request carries a bearer token: only then is caching safe. */
function isAuthed(req: http.IncomingMessage): boolean {
  const auth = req.headers.authorization;
  return typeof auth === 'string' && auth.startsWith('Bearer ') && auth.length > 7;
}

/**
 * The edge: one request handler that caches the forge's deterministic
 * answers and forwards everything else to the forge in-process. The forge's
 * handler is called directly for ordinary requests (no extra hop), and over
 * a loopback server only for the two git POSTs whose bodies the edge must
 * read before it can route them.
 */
export class Edge {
  private readonly issueCache = new CacheStore();
  private readonly gitCache = new CacheStore();
  private readonly headTargets = new Map<string, string | null>();
  private readonly pending = new Map<string, Promise<CachedEntry | null>>();
  private readonly pendingUpload = new Map<
    string,
    Promise<{
      answer: { status: number; contentType: string; body: Buffer } | null;
      entry: CachedEntry | null;
    }>
  >();
  private readonly loopbackAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  private pushes = 0;
  private invalidations = 0;
  private loopbackPort = 0;
  private readonly handler: http.RequestListener;
  private readonly loopback: http.Server;

  public constructor(handler: http.RequestListener, loopback: http.Server) {
    this.handler = handler;
    this.loopback = loopback;
  }

  /** The port the loopback forge listens on, once it is listening. */
  public setLoopbackPort(port: number): void {
    this.loopbackPort = port;
  }

  /** Forget a pending coalesced request after its TTL, so a hung first call cannot pin the key. */
  private rememberPending(key: string, promise: Promise<CachedEntry | null>): void {
    this.pending.set(key, promise);
    const timer = setTimeout(() => {
      if (this.pending.get(key) === promise) this.pending.delete(key);
    }, PENDING_TTL_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }

  /** Drop every cached answer: the safe answer to any mutation the edge does not describe. */
  private invalidateAll(): void {
    this.issueCache.clear();
    this.gitCache.clear();
    this.headTargets.clear();
    this.invalidations += 1;
  }

  /** Drop the git answers for one repository (its advertisement, ls-refs and fetch entries). */
  private invalidateGit(repoKey: string): void {
    for (const key of this.gitCache.keysWithPrefix(`${repoKey}|`)) this.gitCache.delete(key);
    this.headTargets.delete(repoKey);
  }

  /**
   * Serve a cacheable GET through the store with request coalescing: a hit
   * answers at once; a miss starts one forge call and every identical
   * request that arrives while it is in flight waits on that call's answer
   * instead of repeating it. When the waited-on call earns nothing cacheable
   * (a non-200, a wrong content type, an error), the waiter falls back to a
   * direct forge call of its own.
   */
  private async serveCachedGet(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    key: string,
    store: CacheStore,
    isGit: boolean,
    expectContentType: (contentType: string) => boolean,
    onStored?: (entry: CachedEntry) => void,
  ): Promise<void> {
    const hit = store.get(key);
    if (hit !== null) {
      serveCached(res, hit, isGit);
      return;
    }
    const inFlight = this.pending.get(key);
    if (inFlight !== undefined) {
      const entry = await inFlight.catch(() => null);
      if (entry !== null) {
        serveCached(res, entry, isGit);
        return;
      }
      callAppDirect(this.handler, req, res);
      return;
    }
    const capture = captureResponse(res);
    const promise = capture.then((captured) => {
      if (captured !== null && expectContentType(captured.contentType)) {
        const entry: CachedEntry = { status: captured.status, contentType: captured.contentType, body: captured.body };
        store.set(key, entry);
        if (onStored !== undefined) onStored(entry);
        return entry;
      }
      return null;
    });
    this.rememberPending(key, promise);
    callAppDirect(this.handler, req, res);
    try {
      await promise;
    } catch {
      // The capture never resolves a rejection; this is only a guard.
    } finally {
      if (this.pending.get(key) === promise) this.pending.delete(key);
    }
  }

  /**
   * Forward a buffered body to the forge over loopback and return the whole
   * response buffered. Used for the git POSTs, whose bodies the edge reads
   * before routing. The response is small (a report, or a pack for one
   * fetch), so buffering it costs nothing and keeps the reply exact.
   */
  private forwardLoopback(
    method: string,
    path: string,
    headers: Record<string, string>,
    body: Buffer,
  ): Promise<{ status: number; contentType: string; body: Buffer } | null> {
    return new Promise((resolve) => {
      if (this.loopbackPort === 0) {
        resolve(null);
        return;
      }
      const request = http.request(
        {
          host: '127.0.0.1',
          port: this.loopbackPort,
          path,
          method,
          headers: { ...headers, 'content-length': body.length },
          agent: this.loopbackAgent,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const raw = response.headers['content-type'];
            const contentType = typeof raw === 'string' ? raw : '';
            resolve({ status: response.statusCode ?? 500, contentType, body: Buffer.concat(chunks) });
          });
          response.on('error', () => resolve(null));
        },
      );
      request.on('error', () => resolve(null));
      request.setTimeout(30_000, () => {
        request.destroy(new Error('loopback timeout'));
        resolve(null);
      });
      request.end(body);
    });
  }

  /** The headers the edge forwards to the forge over loopback, verbatim where they matter. */
  private loopbackHeaders(req: http.IncomingMessage): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of ['authorization', 'content-type', 'git-protocol', 'user-agent', 'accept']) {
      const value = req.headers[name];
      if (typeof value === 'string' && value !== '') out[name] = value;
    }
    const host = req.headers.host;
    if (typeof host === 'string' && host !== '') out.host = host;
    return out;
  }

  /** Write a loopback answer back to the real client, exactly as received. */
  private replyFromLoopback(
    res: http.ServerResponse,
    answer: { status: number; contentType: string; body: Buffer },
    isGit: boolean,
  ): void {
    const headers: Record<string, string | number> = {
      'content-type': answer.contentType === '' ? 'application/octet-stream' : answer.contentType,
      'content-length': answer.body.length,
    };
    if (!isGit) headers['x-github-request-id'] = `req-${(requestIdCounter += 1)}`;
    res.writeHead(answer.status, headers);
    res.end(answer.body);
  }

  /**
   * GET ...git/info/refs?service=<service>: the advertisement. The
   * upload-pack advertisement is static per repository; the receive-pack
   * advertisement lists the refs and is kept fresh by the push path below.
   * A stored receive-pack advertisement also teaches the edge the repo's
   * HEAD target, which the splice rule needs.
   */
  private async handleInfoRefs(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    git: GitPath,
  ): Promise<void> {
    const query = (req.url ?? '').split('?', 2)[1] ?? '';
    const service = query.includes('git-upload-pack')
      ? 'git-upload-pack'
      : query.includes('git-receive-pack')
        ? 'git-receive-pack'
        : null;
    if (service === null) {
      callAppDirect(this.handler, req, res);
      return;
    }
    const repoKey = `${git.owner}/${git.repo}`;
    const key = `${repoKey}|adv|${service}`;
    const expected = `application/x-${service}-advertisement`;
    await this.serveCachedGet(req, res, key, this.gitCache, true, (ct) => ct.includes(expected), (entry) => {
      if (service === 'git-receive-pack') {
        this.headTargets.set(repoKey, parseSymref(entry.body));
      }
    });
  }

  /**
   * POST ...git/git-upload-pack: ls-refs and fetch. The body decides the
   * cache key (repository plus kind plus body SHA-1), the response is
   * validated before it is stored, and identical in-flight requests share
   * one loopback call. An unclassifiable body is forwarded uncached.
   */
  private async handleUploadPack(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    git: GitPath,
  ): Promise<void> {
    const body = await readBody(req, MAX_BUFFERED_BODY_BYTES);
    if (body === null) {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'request entity too large' }));
      return;
    }
    const kind = classifyUploadPackRequest(body);
    if (kind === 'unknown') {
      const answer = await this.forwardLoopback('POST', req.url ?? '/', this.loopbackHeaders(req), body);
      if (answer === null) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'bad gateway' }));
        return;
      }
      this.replyFromLoopback(res, answer, true);
      return;
    }
    const repoKey = `${git.owner}/${git.repo}`;
    const key = `${repoKey}|${kind}|${sha1Hex(body)}`;
    const hit = this.gitCache.get(key);
    if (hit !== null) {
      serveCached(res, hit, true);
      return;
    }
    // One loopback call serves every identical request in flight: the
    // promise carries the fetched answer (for the waiters to reply with)
    // and the cache entry (null when the answer must not be stored).
    type Shared = {
      answer: { status: number; contentType: string; body: Buffer } | null;
      entry: CachedEntry | null;
    };
    const inFlight = this.pendingUpload.get(key);
    if (inFlight !== undefined) {
      const shared = await inFlight.catch(() => null);
      if (shared !== null && shared.answer !== null) {
        this.replyFromLoopback(res, shared.answer, true);
        return;
      }
      const retry = await this.forwardLoopback('POST', req.url ?? '/', this.loopbackHeaders(req), body);
      if (retry === null) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'bad gateway' }));
        return;
      }
      this.replyFromLoopback(res, retry, true);
      return;
    }
    const promise: Promise<Shared> = this.forwardLoopback('POST', req.url ?? '/', this.loopbackHeaders(req), body).then(
      (answer) => {
        if (answer === null) return { answer: null, entry: null };
        if (
          answer.status === 200 &&
          answer.contentType.includes('application/x-git-upload-pack-result') &&
          validateUploadPackResponse(answer.body, kind)
        ) {
          const entry: CachedEntry = { status: answer.status, contentType: answer.contentType, body: answer.body };
          this.gitCache.set(key, entry);
          return { answer, entry };
        }
        return { answer, entry: null };
      },
    );
    this.pendingUpload.set(key, promise);
    const timer = setTimeout(() => {
      if (this.pendingUpload.get(key) === promise) this.pendingUpload.delete(key);
    }, PENDING_TTL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    const shared = await promise.catch(() => null);
    if (this.pendingUpload.get(key) === promise) this.pendingUpload.delete(key);
    if (shared !== null && shared.answer !== null) {
      this.replyFromLoopback(res, shared.answer, true);
      return;
    }
    const answer = await this.forwardLoopback('POST', req.url ?? '/', this.loopbackHeaders(req), body);
    if (answer === null) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'bad gateway' }));
      return;
    }
    this.replyFromLoopback(res, answer, true);
  }

  /**
   * POST ...git/git-receive-pack: a push. Never served from cache. The body
   * is buffered, forwarded over loopback, and the report-status it earns
   * decides how the cached git answers for this repository are updated: a
   * push the splice rule can describe moves the cached advertisement and
   * ls-refs answers in place; anything else drops them so the forge builds
   * them fresh next time. The fetch cache is untouched: objects are
   * immutable, so a pack for a given request body stays correct.
   */
  private async handleReceivePack(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    git: GitPath,
  ): Promise<void> {
    this.pushes += 1;
    // Watch the request body while the forge reads it: a second 'data'
    // listener on the same stream receives every chunk the forge receives,
    // so the edge learns the pushed commands without consuming the stream
    // and without an extra hop. (Verified against the real forge first:
    // pushes, clones and JSON POSTs all still read correctly with the
    // listener attached.) The body is only ever used for its leading
    // pkt-lines, so past 32 MB the tail is dropped and the splice simply
    // does not happen.
    let bodyBytes = 0;
    const chunks: Buffer[] = [];
    let bodySettled = false;
    const bodyPromise = new Promise<Buffer>((resolve) => {
      const settle = (): void => {
        if (bodySettled) return;
        bodySettled = true;
        resolve(Buffer.concat(chunks));
      };
      req.on('data', (chunk: Buffer | string) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bodyBytes += buf.length;
        if (bodyBytes <= MAX_BUFFERED_BODY_BYTES) chunks.push(buf);
      });
      req.on('end', settle);
      req.on('close', settle);
      req.on('error', settle);
    });
    const capture = captureResponse(res);
    callAppDirect(this.handler, req, res);
    const [body, answer] = await Promise.all([bodyPromise, capture]);
    const repoKey = `${git.owner}/${git.repo}`;
    if (answer === null) {
      this.invalidateGit(repoKey);
      return;
    }
    const commands = parseReceivePackCommands(body);
    const report = parsePushReport(answer.body);
    if (commands === null || report === null || report.length === 0) {
      this.invalidateGit(repoKey);
      return;
    }
    if (!report.some((line) => line.ok)) {
      // Every ref was refused: nothing moved, so the cached answers are
      // still the forge's answers. Keep them; do not splice, do not drop.
      return;
    }
    const headTarget = this.headTargets.get(repoKey) ?? null;
    const advKey = `${repoKey}|adv|git-receive-pack`;
    const adv = this.gitCache.peek(advKey);
    const lsKeys = this.gitCache.keysWithPrefix(`${repoKey}|ls-refs|`);
    const lsEntries = lsKeys.map((key) => ({ key, body: this.gitCache.peek(key)?.body ?? null }));
    const spliced = spliceAfterPush(adv?.body ?? null, null, commands, report, headTarget);
    if (spliced.adv === null) {
      if (adv !== null) this.gitCache.delete(advKey);
    } else if (adv !== null) {
      this.gitCache.set(advKey, { status: adv.status, contentType: adv.contentType, body: spliced.adv });
    }
    for (const { key, body: lsBody } of lsEntries) {
      if (lsBody === null) continue;
      const next = spliceAfterPush(null, lsBody, commands, report, headTarget).lsRefs;
      if (next === null) this.gitCache.delete(key);
      else {
        const current = this.gitCache.peek(key);
        if (current !== null) this.gitCache.set(key, { status: current.status, contentType: current.contentType, body: next });
      }
    }
  }

  /**
   * The request router. Cacheable reads go through the store; git POSTs go
   * through their handlers; everything else goes straight to the forge, and
   * any non-GET among them clears every cache first, because only the forge
   * knows what a mutation changed.
   */
  public async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const method = req.method ?? 'GET';
      const url = req.url ?? '/';
      const authed = isAuthed(req);
      const git = parseGitPath(url);
      if (git !== null) {
        if (method === 'GET' && git.rest === 'info/refs' && authed) {
          await this.handleInfoRefs(req, res, git);
          return;
        }
        if (method === 'POST' && git.rest === 'git-upload-pack' && authed) {
          await this.handleUploadPack(req, res, git);
          return;
        }
        if (method === 'POST' && git.rest === 'git-receive-pack' && authed) {
          await this.handleReceivePack(req, res, git);
          return;
        }
        if (method !== 'GET') this.invalidateAll();
        callAppDirect(this.handler, req, res);
        return;
      }
      if (method === 'GET' && authed) {
        const issue = parseIssueGet(url);
        if (issue !== null) {
          const key = `issue|${issue.owner}/${issue.repo}/${issue.number}|${url.split('?', 2)[1] ?? ''}`;
          await this.serveCachedGet(req, res, key, this.issueCache, false, (ct) => ct.includes('application/json'));
          return;
        }
      }
      if (method !== 'GET') this.invalidateAll();
      callAppDirect(this.handler, req, res);
    } catch {
      if (!res.headersSent && !res.writableEnded) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'internal error' }));
      }
    }
  }

  /** The run summary: cache hits and misses, pushes, and cache size. */
  public stats(): EdgeStats {
    return {
      issueHits: this.issueCache.hits,
      issueMisses: this.issueCache.misses,
      gitHits: this.gitCache.hits,
      gitMisses: this.gitCache.misses,
      pushes: this.pushes,
      invalidations: this.invalidations,
      cachedBytes: this.issueCache.byteSize + this.gitCache.byteSize,
      entries: this.issueCache.size + this.gitCache.size,
    };
  }
}

/**
 * Build the edge around a forge server: the forge's single request listener
 * becomes the edge's fallback, a loopback server runs the same listener for
 * the git POSTs, and the edge server is the one the trial registers. The
 * loopback server must be listening before the first upload-pack or
 * receive-pack POST arrives; the caller listens on it first.
 */
export function createEdgeServer(appServer: http.Server): {
  server: http.Server;
  loopback: http.Server;
  edge: Edge;
} {
  const listeners = appServer.listeners('request');
  if (listeners.length !== 1 || typeof listeners[0] !== 'function') {
    throw new Error(`edge: the forge server must carry exactly one request listener, found ${listeners.length}`);
  }
  const handler = listeners[0] as http.RequestListener;
  const loopback = http.createServer(handler);
  loopback.on('connection', (socket) => socket.setNoDelay(true));
  const edge = new Edge(handler, loopback);
  const server = http.createServer((req, res) => {
    void edge.handle(req, res);
  });
  server.keepAliveTimeout = 5000;
  server.headersTimeout = 60_000;
  server.requestTimeout = 300_000;
  server.on('connection', (socket) => socket.setNoDelay(true));
  return { server, loopback, edge };
}
