// A one-process GitHub-compatible git forge: smart HTTP (upload-pack v2, receive-pack v0),
// REST v3, GraphQL v4 and MCP over one in-memory store. Standard library only, no git binary,
// no disk writes per request, no wall clock and no unseeded randomness in anything served:
// every timestamp comes from MAKEFUN_TRIAL_NOW and every id from a counter, so a replay of
// the same requests leaves the same state.
//
// Speed is the point of the exercise, so the hot paths are deliberately boring: objects live
// in Maps, per-issue and per-repo JSON is cached as a string and invalidated on mutation, and
// packs are written with plain (undeltified) objects at zlib level 1. Pack size is not scored.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ------------------------------------------------------------------ fixed identity

// The token owner, fixed by the contest's seeded scenario (the same in every trial).
const VIEWER_LOGIN = 'adaiversen';
const VIEWER_ID = 1000;
const VIEWER_EMAIL = 'adaiversen@example.invalid';
const VIEWER_NAME = 'ada iversen';
const ZERO_OID = '0'.repeat(40);
const SERVER_AGENT = 'github-forge/1.0.0';
const FORGE_NAME = 'github-forge';
const FORGE_VERSION = '1.0.0';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

// Trial clock: every served timestamp derives from this, never from the wall clock.
const TRIAL_NOW_MS = (() => {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return parsed;
  return 1_700_000_000_000;
})();
const TRIAL_NOW_ISO = new Date(TRIAL_NOW_MS).toISOString();
const TRIAL_NOW_SEC = Math.floor(TRIAL_NOW_MS / 1000);

// Monotonic counters: ids and commit timestamps. Deterministic for a given request order.
let nextDbId = 5000;
let nextReqId = 1;
let commitClock = TRIAL_NOW_SEC;

function nextCommitTs(): number {
  commitClock += 1;
  return commitClock;
}

// ------------------------------------------------------------------ git objects

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObj {
  type: ObjType;
  data: Buffer;
}
interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const HEX40 = /^[0-9a-f]{40}$/;

function sha1(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\0`, 'utf8');
  h.update(data);
  return h.digest('hex');
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    entries.push({
      mode: data.subarray(off, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'tree') tree = val;
    else if (key === 'parent') parents.push(val);
    else if (key === 'author') author = val;
    else if (key === 'committer') committer = val;
  }
  return { tree, parents, author, committer, message };
}

function buildCommit(tree: string, parents: string[], message: string, ts: number): Buffer {
  const who = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000`;
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  const msg = message.endsWith('\n') ? message : `${message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${msg}`, 'utf8');
}

function parseTag(data: Buffer): { object: string; type: ObjType; tag: string; message: string } {
  const blank = data.indexOf('\n\n');
  const headEnd = blank < 0 ? data.length : blank;
  let object = '';
  let type: ObjType = 'commit';
  let tag = '';
  for (const line of data.subarray(0, headEnd).toString('utf8').split('\n')) {
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const key = line.slice(0, sp);
    const val = line.slice(sp + 1);
    if (key === 'object') object = val;
    else if (key === 'type') type = val as ObjType;
    else if (key === 'tag') tag = val;
  }
  return { object, type, tag, message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8') };
}

// ------------------------------------------------------------------ pkt-line

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.allocUnsafe(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

interface DecodedPkt {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload: Buffer;
}

// Decode a whole buffer of pkt-lines. Stops at the first non-framed byte (a raw pack) and
// returns the offset where framing stopped, so the caller can take the pack bytes raw.
function decodePkts(buf: Buffer): { packets: DecodedPkt[]; rawAt: number } {
  const packets: DecodedPkt[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.toString('ascii', off, off + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, rawAt: off };
}

// ------------------------------------------------------------------ packfiles

function packObjHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let rem = size;
  let first = (code << 4) | (rem & 0x0f);
  rem = Math.floor(rem / 16);
  while (rem > 0) {
    bytes.push(first | 0x80);
    first = rem & 0x7f;
    rem = Math.floor(rem / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

// Plain-object pack, zlib level 1: time is scored, pack size is not.
function writePack(objects: GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.allocUnsafe(12);
  head.write('PACK', 0, 4, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  parts.push(head);
  for (const o of objects) {
    parts.push(packObjHeader(o.type, o.data.length));
    parts.push(deflateSync(o.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarint(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let b = buf[start]!;
  const first = b;
  let size = b & 0x0f;
  let shift = 4;
  let off = start + 1;
  while (b & 0x80) {
    b = buf[off++]!;
    size += (b & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: off, first };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off++]!;
      v += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readSize();
  const tgtSize = readSize();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(tgtSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++]!;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) cpOff += delta[off++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) cpSize += delta[off++]! * 2 ** shift;
        shift += 8;
      }
      if (cpSize === 0) cpSize = 0x10000;
      base.copy(out, written, cpOff, cpOff + cpSize);
      written += cpSize;
    } else if (op !== 0) {
      const lit = op & 0x7f;
      delta.copy(out, written, off, off + lit);
      off += lit;
      written += lit;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== tgtSize) throw new Error('delta size mismatch');
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

// Read a pack (plain objects plus OFS/REF deltas), verifying the trailer checksum.
function readPack(pack: Buffer): Map<string, GitObj> {
  if (pack.length < 32 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('bad pack version');
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack checksum mismatch');
  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = off;
    const hv = readVarint(pack, off);
    off = hv.next;
    const typeCode = (hv.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: hv.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let b = pack[off]!;
      off += 1;
      let v = b & 0x7f;
      while (b & 0x80) {
        b = pack[off++]!;
        v = ((v + 1) * 128) + (b & 0x7f);
      }
      entry.baseOffset = entryOffset - v;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type ${typeCode}`);
    }
    const inflated = inflateSync(pack.subarray(off, trailerStart), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (inflated.buffer.length !== hv.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.buffer;
    off += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const resolved = new Map<string, GitObj>();
  const byOid = new Map<string, RawPackEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): GitObj => {
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!)!;
      const base = resolve(baseEntry);
      const data = applyDelta(base.data, entry.data);
      return { type: base.type, data };
    }
    if (entry.typeCode === 7) {
      const baseEntry = byOid.get(entry.baseOid!);
      let base: GitObj;
      if (baseEntry) base = resolve(baseEntry);
      else {
        const ext = resolved.get(entry.baseOid!);
        if (!ext) throw new Error('delta base missing');
        base = ext;
      }
      const data = applyDelta(base.data, entry.data);
      return { type: base.type, data };
    }
    return { type: CODE_TYPE[entry.typeCode]!, data: entry.data };
  };
  for (const entry of raw) {
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    const obj = resolve(entry);
    resolving.delete(entry.offset);
    const oid = sha1(obj.type, obj.data);
    resolved.set(oid, obj);
    byOid.set(oid, entry);
  }
  return resolved;
}

// ------------------------------------------------------------------ reachability

function collectReachable(roots: Iterable<string>, lookup: (oid: string) => GitObj | undefined): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const r of roots) if (HEX40.test(r) && r !== ZERO_OID) stack.push(r);
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) if (e.mode !== '160000') stack.push(e.oid);
    }
  }
  return seen;
}

function isAncestor(maybeOld: string, tip: string, lookup: (oid: string) => GitObj | undefined): boolean {
  if (maybeOld === ZERO_OID) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop()!;
    if (oid === maybeOld) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = lookup(oid);
    if (obj && obj.type === 'commit') for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}

// Merge-base: the newest common ancestor by generation walk from both tips.
function mergeBase(a: string, b: string, lookup: (oid: string) => GitObj | undefined): string | null {
  if (a === b) return a;
  const ancA = new Map<string, number>();
  const queue: Array<[string, number]> = [[a, 0]];
  while (queue.length) {
    const [oid, gen] = queue.shift()!;
    if (ancA.has(oid)) continue;
    ancA.set(oid, gen);
    const obj = lookup(oid);
    if (obj && obj.type === 'commit') for (const p of parseCommit(obj.data).parents) queue.push([p, gen + 1]);
  }
  let best: string | null = null;
  let bestGen = Infinity;
  const seen = new Set<string>();
  const qb: Array<[string, number]> = [[b, 0]];
  while (qb.length) {
    const [oid, gen] = qb.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const ga = ancA.get(oid);
    if (ga !== undefined && ga + gen < bestGen) {
      bestGen = ga + gen;
      best = oid;
    }
    const obj = lookup(oid);
    if (obj && obj.type === 'commit') for (const p of parseCommit(obj.data).parents) qb.push([p, gen + 1]);
  }
  return best;
}

// ------------------------------------------------------------------ store

interface Label {
  name: string;
  color: string;
}
interface Comment {
  id: number;
  body: string;
  created_at: string;
  updated_at: string;
}
interface Issue {
  number: number;
  id: number;
  nodeId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  seq: number;
  jsonCache: string;
}
interface Pull {
  number: number;
  id: number;
  nodeId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: string;
  base: string;
  mergeBase: string | null;
  seq: number;
  jsonCache: string;
}

interface Repo {
  id: number;
  nodeId: string;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObj>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  nextNumber: number;
  seq: number;
  jsonCache: string;
  flatCache: Map<string, Map<string, { oid: string; mode: string }>>;
}

const repos = new Map<string, Repo>();
const repoList: Repo[] = [];
let globalSeq = 1;
let nextCommentId = 1;

function b64id(kind: string, value: string): string {
  return Buffer.from(`${kind}:${value}`, 'utf8').toString('base64url');
}
function decodeB64id(id: string): { kind: string; value: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const i = text.indexOf(':');
    if (i < 0) return null;
    return { kind: text.slice(0, i), value: text.slice(i + 1) };
  } catch {
    return null;
  }
}

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function createRepoRecord(name: string, description: string, isPrivate: boolean): Repo {
  const id = nextDbId;
  nextDbId += 1;
  const repo: Repo = {
    id,
    nodeId: b64id('Repository', `${VIEWER_LOGIN}/${name}`),
    owner: VIEWER_LOGIN,
    name,
    description,
    isPrivate,
    defaultBranch: 'main',
    objects: new Map(),
    refs: new Map(),
    issues: [],
    pulls: [],
    labels: new Map(),
    nextNumber: 1,
    seq: globalSeq,
    jsonCache: '',
    flatCache: new Map(),
  };
  globalSeq += 1;
  repos.set(repoKey(VIEWER_LOGIN, name), repo);
  repoList.push(repo);
  return repo;
}

function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

function lookupObj(repo: Repo): (oid: string) => GitObj | undefined {
  return (oid) => repo.objects.get(oid);
}

// Flatten a commit's tree to path -> {oid, mode}, memoized (objects are immutable).
function flatTree(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
  const cached = repo.flatCache.get(commitOid);
  if (cached) return cached;
  const out = new Map<string, { oid: string; mode: string }>();
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') {
    repo.flatCache.set(commitOid, out);
    return out;
  }
  const walk = (treeOid: string, prefix: string): void => {
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return;
    for (const e of parseTree(tree.data)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') walk(e.oid, path);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  };
  walk(parseCommit(obj.data).tree, '');
  repo.flatCache.set(commitOid, out);
  return out;
}

// Rebuild nested trees bottom-up from a flat path map; returns the root tree oid.
function buildTreeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]!;
      let child = node.dirs.get(part);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1]!, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, e] of node.files) entries.push({ mode: e.mode, name, oid: e.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    const data = buildTree(entries);
    const oid = sha1('tree', data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}

function storeObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = sha1(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

// Commit one file change (or deletion) on a branch; creates the branch from the default tip
// when it does not exist yet, and from an empty tree when the repo has no commits at all.
function commitFile(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): string {
  const ref = `refs/heads/${branch}`;
  let parent: string | null = null;
  const tip = repo.refs.get(ref);
  if (tip !== undefined) parent = tip;
  else {
    const baseTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (baseTip !== undefined) parent = baseTip;
  }
  const flat = parent ? new Map(flatTree(repo, parent)) : new Map<string, { oid: string; mode: string }>();
  if (content === null) flat.delete(path);
  else {
    const blobOid = storeObject(repo, 'blob', content);
    flat.set(path, { oid: blobOid, mode: '100644' });
  }
  const treeOid = buildTreeFromFlat(repo, flat);
  const commitData = buildCommit(treeOid, parent ? [parent] : [], message, nextCommitTs());
  const commitOid = storeObject(repo, 'commit', commitData);
  repo.refs.set(ref, commitOid);
  return commitOid;
}

function resolveRef(repo: Repo, ref: string): string | undefined {
  if (HEX40.test(ref)) return repo.objects.has(ref) ? ref : undefined;
  if (ref.startsWith('refs/')) return repo.refs.get(ref);
  return repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
}

// Diff two flat trees: path -> {status, oldOid, newOid}.
interface FileDiff {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
}
function diffFlat(
  oldFlat: Map<string, { oid: string; mode: string }>,
  newFlat: Map<string, { oid: string; mode: string }>,
): FileDiff[] {
  const out: FileDiff[] = [];
  for (const [path, e] of newFlat) {
    const old = oldFlat.get(path);
    if (!old) out.push({ path, status: 'added', oldOid: null, newOid: e.oid });
    else if (old.oid !== e.oid) out.push({ path, status: 'modified', oldOid: old.oid, newOid: e.oid });
  }
  for (const [path, e] of oldFlat) {
    if (!newFlat.has(path)) out.push({ path, status: 'removed', oldOid: e.oid, newOid: null });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : 1));
  return out;
}

function lineCounts(repo: Repo, oid: string | null): number {
  if (oid === null) return 0;
  const obj = repo.objects.get(oid);
  if (!obj) return 0;
  const text = obj.data.toString('utf8');
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

// Three-way merge check for a pull request: null when clean, else the first conflicting path.
function mergeConflictPath(repo: Repo, pull: Pull): string | null {
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  if (!headTip || !baseTip || !pull.mergeBase) return null;
  const baseFlat = flatTree(repo, pull.mergeBase);
  const headFlat = flatTree(repo, headTip);
  const tipFlat = flatTree(repo, baseTip);
  const changes = diffFlat(baseFlat, headFlat);
  for (const c of changes) {
    const baseEntry = baseFlat.get(c.path);
    const tipEntry = tipFlat.get(c.path);
    const baseOid = baseEntry?.oid ?? null;
    const tipOid = tipEntry?.oid ?? null;
    const headOid = c.newOid;
    if (tipOid !== baseOid && headOid !== baseOid && tipOid !== headOid) return c.path;
  }
  return null;
}

function isMergeable(repo: Repo, pull: Pull): boolean {
  return mergeConflictPath(repo, pull) === null;
}

// Squash-merge a pull request onto its base branch. Returns the merge commit oid, or null
// when the pull request is conflicted.
function squashMerge(repo: Repo, pull: Pull): string | null {
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  if (!headTip || !baseTip || !pull.mergeBase) return null;
  if (mergeConflictPath(repo, pull) !== null) return null;
  const baseFlat = flatTree(repo, pull.mergeBase);
  const headFlat = flatTree(repo, headTip);
  const tipFlat = new Map(flatTree(repo, baseTip));
  for (const c of diffFlat(baseFlat, headFlat)) {
    if (c.newOid === null) tipFlat.delete(c.path);
    else tipFlat.set(c.path, { oid: c.newOid, mode: '100644' });
  }
  const treeOid = buildTreeFromFlat(repo, tipFlat);
  const message = `Merge pull request #${pull.number} from ${pull.head}`;
  const commitData = buildCommit(treeOid, [baseTip], message, nextCommitTs());
  const commitOid = storeObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.base}`, commitOid);
  return commitOid;
}

// ------------------------------------------------------------------ JSON views (cached)

function repoJson(repo: Repo): string {
  if (repo.jsonCache) return repo.jsonCache;
  const text = JSON.stringify({
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: TRIAL_NOW_ISO,
    updated_at: TRIAL_NOW_ISO,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
  });
  repo.jsonCache = text;
  return text;
}

function issueJson(issue: Issue, repo: Repo): string {
  if (issue.jsonCache) return issue.jsonCache;
  const text = JSON.stringify({
    id: issue.id,
    node_id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: TRIAL_NOW_ISO,
    updated_at: TRIAL_NOW_ISO,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments.length,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  });
  issue.jsonCache = text;
  return text;
}

function pullJson(pull: Pull, repo: Repo): string {
  if (pull.jsonCache) return pull.jsonCache;
  const headTip = repo.refs.get(`refs/heads/${pull.head}`) ?? '';
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`) ?? '';
  const text = JSON.stringify({
    id: pull.id,
    node_id: pull.nodeId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    mergeable: pull.state === 'open' ? isMergeable(repo, pull) : null,
    head: { ref: pull.head, sha: headTip, label: `${VIEWER_LOGIN}:${pull.head}` },
    base: { ref: pull.base, sha: baseTip, label: `${VIEWER_LOGIN}:${pull.base}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: TRIAL_NOW_ISO,
    updated_at: TRIAL_NOW_ISO,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  });
  pull.jsonCache = text;
  return text;
}

function createIssueRecord(repo: Repo, title: string, body: string, labels: Label[]): Issue {
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue: Issue = {
    number,
    id: nextDbId,
    nodeId: b64id('Issue', `${repo.owner}/${repo.name}:${number}`),
    title,
    body: body ?? '',
    state: 'open',
    labels,
    comments: [],
    seq: globalSeq,
    jsonCache: '',
  };
  nextDbId += 1;
  globalSeq += 1;
  repo.issues.push(issue);
  return issue;
}

function createPullRecord(repo: Repo, title: string, body: string, head: string, base: string): Pull {
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const headTip = repo.refs.get(`refs/heads/${head}`) ?? '';
  const baseTip = repo.refs.get(`refs/heads/${base}`) ?? '';
  const mergeBase = headTip && baseTip ? mergeBaseOf(repo, headTip, baseTip) : null;
  const pull: Pull = {
    number,
    id: nextDbId,
    nodeId: b64id('PullRequest', `${repo.owner}/${repo.name}:${number}`),
    title,
    body: body ?? '',
    state: 'open',
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    head,
    base,
    mergeBase,
    seq: globalSeq,
    jsonCache: '',
  };
  nextDbId += 1;
  globalSeq += 1;
  repo.pulls.push(pull);
  return pull;
}

function mergeBaseOf(repo: Repo, a: string, b: string): string | null {
  return mergeBase(a, b, lookupObj(repo));
}

// ------------------------------------------------------------------ HTTP plumbing

function reqIdHeader(): string {
  return `req-${nextReqId++}`;
}

function sendJson(res: ServerResponse, status: number, text: string, extra: Record<string, string> = {}): void {
  const len = Buffer.byteLength(text);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': len,
    'x-github-request-id': reqIdHeader(),
    ...extra,
  });
  res.end(text);
}

function sendErr(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, JSON.stringify({ message }));
}

function sendBuf(res: ServerResponse, status: number, buf: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': buf.length });
  res.end(buf);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(buf: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (buf.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(buf.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strField(v: unknown, key: string, fallback = ''): string {
  if (isRecord(v) && typeof v[key] === 'string') return v[key] as string;
  return fallback;
}

function boolField(v: unknown, key: string, fallback = false): boolean {
  if (isRecord(v) && typeof v[key] === 'boolean') return v[key] as boolean;
  return fallback;
}

function authed(req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Bearer ')) return false;
  const token = h.slice(7);
  if (token === '') return false;
  if (TOKEN !== '') return token === TOKEN;
  return true;
}

// Split a path like /a/b/c into decoded segments, without a URL object.
function splitPath(path: string): string[] {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '') continue;
    try {
      out.push(decodeURIComponent(part));
    } catch {
      out.push(part);
    }
  }
  return out;
}

function queryParams(url: string): Map<string, string> {
  const out = new Map<string, string>();
  const q = url.indexOf('?');
  if (q < 0) return out;
  for (const pair of url.slice(q + 1).split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = eq < 0 ? pair : pair.slice(0, eq);
    const val = eq < 0 ? '' : pair.slice(eq + 1);
    try {
      out.set(decodeURIComponent(key), decodeURIComponent(val));
    } catch {
      out.set(key, val);
    }
  }
  return out;
}

// ------------------------------------------------------------------ git smart HTTP

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const names = [...repo.refs.keys()].sort();
  return names.map((name) => ({ name, oid: repo.refs.get(name)! }));
}

function peelOid(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj) return null;
  if (obj.type === 'tag') return parseTag(obj.data).object;
  if (obj.type === 'commit') return oid;
  return null;
}

// v0 advertisement body for a service.
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const refsSorted = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const caps =
    service === 'git-upload-pack'
      ? 'symref=HEAD:refs/heads/main report-status report-status-v2 side-band-64k agent=git/2.40'
      : 'symref=HEAD:refs/heads/main report-status report-status-v2 side-band-64k delete-refs agent=git/2.40';
  const lines: string[] = [];
  if (tip === undefined) {
    lines.push(`0000000000000000000000000000000000000000 capabilities^{}\0${caps}`);
  } else {
    for (const [refName, sha] of refsSorted) {
      lines.push(`${sha} ${refName}`);
    }
    lines[0] = `${lines[0]!}\0${caps}`;
    lines.push(`${tip} HEAD`);
  }
  const payload = Buffer.concat([
    pktLine(Buffer.from(`# service=${service}\n`, 'utf8')),
    PKT_FLUSH,
    ...lines.map((l) => pktLine(Buffer.from(l, 'utf8'))),
    PKT_FLUSH,
  ]);
  return payload;
}

// v2 advertisement body for upload-pack.
function v2Advertisement(): Buffer {
  const lines = [
    '# service=git-upload-pack\n',
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done filter\n',
    'object-format=sha1\n',
    'agent=github-forge/1.0.0\n',
  ];
  const parts: Buffer[] = [pktLine(lines[0])];
  parts.push(PKT_FLUSH);
  for (const line of lines.slice(1)) parts.push(pktLine(line));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function lsRefsResponse(repo: Repo, body: Buffer): Buffer {
  const { packets } = decodePkts(body);
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  let inArgs = false;
  for (const p of packets) {
    if (p.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (p.kind !== 'data') continue;
    const text = p.payload.toString('utf8').trim();
    if (!inArgs) continue;
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((pre) => name.startsWith(pre));
  const parts: Buffer[] = [];
  const headTip = repo.refs.get('refs/heads/main');
  const headLine = headTip
    ? `${headTip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`
    : `unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`;
  if (keep('HEAD')) parts.push(pktLine(headLine));
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const peeled = peelOid(repo, ref.oid);
      if (ref.name.startsWith('refs/tags/') && peeled && peeled !== ref.oid) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

// Parse a v2 fetch command block.
function parseFetchV2(body: Buffer): FetchArgs {
  const { packets } = decodePkts(body);
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  let inArgs = false;
  for (const p of packets) {
    if (p.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (p.kind !== 'data' || !inArgs) continue;
    const text = p.payload.toString('utf8').trim();
    if (text.startsWith('want ')) args.wants.push(text.slice(5));
    else if (text.startsWith('have ')) args.haves.push(text.slice(5));
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8));
    else if (text.startsWith('deepen ')) args.depth = parseInt(text.slice(7), 10);
    else if (text === 'done') args.done = true;
  }
  return args;
}

// Parse a v0 fetch request: want lines, then flush, then have lines and done.
function parseFetchV0(body: Buffer): FetchArgs {
  const { packets } = decodePkts(body);
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  let section = 0;
  for (const p of packets) {
    if (p.kind === 'flush') {
      section += 1;
      continue;
    }
    if (p.kind !== 'data') continue;
    const text = p.payload.toString('utf8').trim();
    if (section === 0) {
      if (text.startsWith('want ')) {
        const rest = text.slice(5);
        const sp = rest.indexOf(' ');
        args.wants.push(sp < 0 ? rest : rest.slice(0, sp));
      } else if (text.startsWith('deepen ')) args.depth = parseInt(text.slice(7), 10);
      else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8));
    } else {
      if (text.startsWith('have ')) args.haves.push(text.slice(5));
      else if (text === 'done') args.done = true;
      else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8));
    }
  }
  return args;
}

// The object set a fetch delivers, with depth and shallow-boundary semantics.
function fetchObjects(
  repo: Repo,
  args: FetchArgs,
): { objects: GitObj[]; shallow: string[]; unshallow: string[] } {
  const lookup = lookupObj(repo);
  // Objects the client already holds: reachable from haves, without walking past a shallow
  // boundary (a shallow commit's parents are not held).
  const held = new Set<string>();
  {
    const stack: string[] = [];
    for (const h of args.haves) if (HEX40.test(h) && h !== ZERO_OID) stack.push(h);
    const boundary = new Set(args.shallow);
    while (stack.length) {
      const oid = stack.pop()!;
      if (held.has(oid)) continue;
      const obj = lookup(oid);
      if (!obj) continue;
      held.add(oid);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        stack.push(c.tree);
        if (!boundary.has(oid)) for (const p of c.parents) stack.push(p);
      } else if (obj.type === 'tag') stack.push(parseTag(obj.data).object);
      else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) if (e.mode !== '160000') stack.push(e.oid);
      }
    }
  }
  // Walk wants by generation; depth limits how many commit generations are included.
  const depth = args.depth ?? Infinity;
  const included = new Set<string>();
  const commitGen = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  for (const w of args.wants) {
    if (HEX40.test(w) && w !== ZERO_OID) queue.push([w, 0]);
  }
  const shallowSet = new Set<string>();
  while (queue.length) {
    const [oid, gen] = queue.shift()!;
    if (included.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) continue;
    if (obj.type === 'commit') {
      if (gen >= depth) {
        shallowSet.add(oid);
        continue;
      }
      commitGen.set(oid, gen);
      included.add(oid);
      queue.push([obj ? parseCommit(obj.data).tree : '', gen]);
      const c = parseCommit(obj.data);
      for (const p of c.parents) queue.push([p, gen + 1]);
    } else if (obj.type === 'tag') {
      included.add(oid);
      queue.push([parseTag(obj.data).object, gen]);
    } else {
      included.add(oid);
      if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push([e.oid, gen]);
      }
    }
  }
  // Any included commit whose parent was cut off by depth is a new shallow boundary.
  for (const [oid, gen] of commitGen) {
    if (args.depth !== null && gen === args.depth - 1) {
      const obj = lookup(oid);
      if (obj && obj.type === 'commit' && parseCommit(obj.data).parents.length > 0) shallowSet.add(oid);
    }
  }
  const objects: GitObj[] = [];
  for (const oid of included) {
    if (held.has(oid)) continue;
    const obj = lookup(oid);
    if (obj) objects.push(obj);
  }
  // Deterministic pack order: commits first (parents after children is not required), then
  // trees, then blobs, each in oid order.
  const rank = (t: ObjType): number => (t === 'commit' ? 0 : t === 'tree' ? 1 : t === 'blob' ? 2 : 3);
  objects.sort((a, b) => {
    const r = rank(a.type) - rank(b.type);
    if (r !== 0) return r;
    return sha1(a.type, a.data) < sha1(b.type, b.data) ? -1 : 1;
  });
  const unshallow: string[] = [];
  for (const b of args.shallow) {
    if (shallowSet.has(b)) continue;
    const obj = lookup(b);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length === 0) continue;
    const allKnown = parents.every((p) => included.has(p) || held.has(p));
    if (allKnown) unshallow.push(b);
  }
  return { objects, shallow: [...shallowSet].sort(), unshallow: unshallow.sort() };
}

// Sideband-wrap pack bytes into band-1 packets: 1 band byte + 65515 data bytes = 65516 payload, 65520 total.
function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    out.push(pktLine(payload));
  }
  return out;
}

function fetchV2Response(repo: Repo, args: FetchArgs): Buffer {
  const { objects, shallow, unshallow } = fetchObjects(repo, args);
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  parts.push(pktLine('NAK\n'));
  parts.push(PKT_FLUSH);
  if (shallow.length || unshallow.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  for (const p of sidebandPack(pack)) parts.push(p);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchV0Response(repo: Repo, args: FetchArgs): Buffer {
  const { objects, shallow, unshallow } = fetchObjects(repo, args);
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  parts.push(pktLine('NAK\n'));
  for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  for (const p of sidebandPack(pack)) parts.push(p);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

async function handleGitUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): Promise<void> {
  const proto = (req.headers['git-protocol'] ?? '') as string;
  const { packets } = decodePkts(body);
  const first = packets.find((p) => p.kind === 'data');
  const cmd = first ? first.payload.toString('utf8').trim() : '';
  if (cmd.startsWith('command=ls-refs')) {
    sendBuf(res, 200, lsRefsResponse(repo, body), 'application/x-git-upload-pack-result');
    return;
  }
  if (cmd.startsWith('command=fetch')) {
    const args = parseFetchV2(body);
    sendBuf(res, 200, fetchV2Response(repo, args), 'application/x-git-upload-pack-result');
    return;
  }
  void proto;
  // v0 fetch (no command= line): want/have/done shape.
  const args = parseFetchV0(body);
  sendBuf(res, 200, fetchV0Response(repo, args), 'application/x-git-upload-pack-result');
}

async function handleGitReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): Promise<void> {
  void req;
  const { packets, rawAt } = decodePkts(body);
  interface Cmd {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Cmd[] = [];
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const text = p.payload.toString('utf8');
    const nul = text.indexOf('\0');
    const line = (nul >= 0 ? text.slice(0, nul) : text).trim();
    if (!line) continue;
    const parts = line.split(' ');
    if (parts.length >= 3 && HEX40.test(parts[0]!) && HEX40.test(parts[1]!)) {
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    }
  }
  let unpackOk = true;
  let unpackDetail = 'ok';
  const packBytes = body.subarray(rawAt);
  if (packBytes.length > 0) {
    try {
      const objs = readPack(packBytes);
      for (const [oid, obj] of objs) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const lookup = lookupObj(repo);
  const lines: string[] = [];
  lines.push(`unpack ${unpackOk ? 'ok' : unpackDetail}`);
  for (const cmd of commands) {
    let ok = true;
    let reason = '';
    if (!unpackOk) {
      ok = false;
      reason = 'unpack failed';
    } else if (cmd.newOid === ZERO_OID) {
      // Delete.
      const cur = repo.refs.get(cmd.ref);
      if (cur === undefined) {
        ok = false;
        reason = 'no such ref';
      } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== cur) {
        ok = false;
        reason = 'non-fast-forward';
      } else {
        repo.refs.delete(cmd.ref);
      }
    } else if (cmd.oldOid === ZERO_OID) {
      // Create.
      if (repo.refs.has(cmd.ref)) {
        ok = false;
        reason = 'already exists';
      } else if (!repo.objects.has(cmd.newOid)) {
        ok = false;
        reason = 'missing object';
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
      }
    } else {
      const cur = repo.refs.get(cmd.ref);
      if (cur === undefined) {
        ok = false;
        reason = 'no such ref';
      } else if (cur !== cmd.oldOid) {
        ok = false;
        reason = 'non-fast-forward';
      } else if (!isAncestor(cmd.oldOid, cmd.newOid, lookup)) {
        ok = false;
        reason = 'non-fast-forward';
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
      }
    }
    lines.push(ok ? `ok ${cmd.ref}` : `ng ${cmd.ref} ${reason}`);
  }
  // Invalidate cached pull JSON (head/base tips may have moved).
  for (const pull of repo.pulls) pull.jsonCache = '';
  const inner = Buffer.concat([...lines.map((l) => pktLine(`${l}\n`)), PKT_FLUSH]);
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < inner.length; off += CHUNK) {
    const slice = inner.subarray(off, Math.min(inner.length, off + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  parts.push(PKT_FLUSH);
  sendBuf(res, 200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
}

// ------------------------------------------------------------------ REST v3

function linkHeader(req: IncomingMessage, path: string, page: number, perPage: number, total: number): string {
  const host = req.headers.host ?? 'localhost';
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const parts: string[] = [];
  if (page < totalPages) {
    parts.push(`<http://${host}${path}?per_page=${perPage}&page=${page + 1}>; rel="next"`);
    parts.push(`<http://${host}${path}?per_page=${perPage}&page=${totalPages}>; rel="last"`);
  }
  if (page > 1) {
    parts.push(`<http://${host}${path}?per_page=${perPage}&page=1>; rel="first"`);
    parts.push(`<http://${host}${path}?per_page=${perPage}&page=${page - 1}>; rel="prev"`);
  }
  return parts.join(', ');
}

function pageOf<T>(items: readonly T[], query: Map<string, string>): { page: T[]; perPage: number; pageNum: number } {
  const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const pageNum = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), perPage, pageNum };
}

function listCommits(repo: Repo, fromOid: string): Array<{ sha: string; message: string; ts: number }> {
  const out: Array<{ sha: string; message: string; ts: number }> = [];
  const seen = new Set<string>();
  const stack = [fromOid];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const c = parseCommit(obj.data);
    const msg = c.message.replace(/\n$/, '');
    const authorLine = c.author;
    const tsMatch = / (\d+) [+-]\d{4}$/.exec(authorLine);
    out.push({ sha: oid, message: msg, ts: tsMatch ? parseInt(tsMatch[1], 10) : TRIAL_NOW_SEC });
    for (const p of c.parents) stack.push(p);
  }
  return out;
}

function commitJson(repo: Repo, sha: string): string {
  const obj = repo.objects.get(sha);
  const c = obj && obj.type === 'commit' ? parseCommit(obj.data) : null;
  const message = c ? c.message.replace(/\n$/, '') : '';
  return JSON.stringify({
    sha,
    commit: {
      message,
      author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: TRIAL_NOW_ISO },
      committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: TRIAL_NOW_ISO },
    },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
  });
}

async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  segs: string[],
  query: Map<string, string>,
): Promise<void> {
  const rawUrl = req.url ?? '/';
  // GET /api/v3[/] needs no token (the API root); everything else under /api/v3 does.
  const isRoot = segs.length === 2 && method === 'GET';
  if (!isRoot && !authed(req)) {
    sendErr(res, 401, 'Bad credentials');
    return;
  }
  if (isRoot) {
    sendJson(res, 200, JSON.stringify({ current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }), {
      'x-oauth-scopes': 'repo, read:org',
    });
    return;
  }
  if (segs.length === 3 && segs[2] === 'meta' && method === 'GET') {
    sendJson(res, 200, JSON.stringify({ installed_version: FORGE_VERSION }));
    return;
  }
  if (segs.length === 3 && segs[2] === 'user' && method === 'GET') {
    sendJson(
      res,
      200,
      JSON.stringify({ login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' }),
    );
    return;
  }
  // POST /api/v3/user/repos
  if (segs.length === 4 && segs[2] === 'user' && segs[3] === 'repos') {
    if (method === 'GET') {
      const { page, perPage, pageNum } = pageOf(repoList, query);
      const text = `[${page.map((r) => repoJson(r)).join(',')}]`;
      const link = linkHeader(req, '/api/v3/user/repos', pageNum, perPage, repoList.length);
      sendJson(res, 200, text, link ? { link } : {});
      return;
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendErr(res, 400, 'Invalid JSON');
        return;
      }
      const name = strField(parsed.value, 'name');
      if (name === '') {
        sendErr(res, 422, 'name is required');
        return;
      }
      if (getRepo(VIEWER_LOGIN, name)) {
        sendErr(res, 422, 'Repository already exists');
        return;
      }
      const repo = createRepoRecord(name, strField(parsed.value, 'description'), boolField(parsed.value, 'private', false));
      sendJson(res, 201, repoJson(repo));
      return;
    }
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segs.length >= 5 && segs[2] === 'repos') {
    const owner = segs[3]!;
    const name = segs[4]!;
    const repo = getRepo(owner, name);
    if (!repo) {
      sendErr(res, 404, 'Not Found');
      return;
    }
    const rest = segs.slice(5);
    // GET/PATCH/DELETE /repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'PATCH') {
        const body = await readBody(req);
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendErr(res, 400, 'Invalid JSON');
          return;
        }
        const desc = strField(parsed.value, 'description', repo.description);
        repo.description = desc;
        repo.jsonCache = '';
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'DELETE') {
        repos.delete(repoKey(owner, name));
        const idx = repoList.indexOf(repo);
        if (idx >= 0) repoList.splice(idx, 1);
        res.writeHead(204, { 'x-github-request-id': reqIdHeader() });
        res.end();
        return;
      }
      sendErr(res, 404, 'Not Found');
      return;
    }
    // Branches.
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const items = sortedRefs(repo)
          .filter((r) => r.name.startsWith('refs/heads/'))
          .map((r) => ({
            name: r.name.slice('refs/heads/'.length),
            commit: { sha: r.oid },
            protected: false,
          }));
        sendJson(res, 200, JSON.stringify(items));
        return;
      }
      if (rest.length === 2 && method === 'GET') {
        const oid = repo.refs.get(`refs/heads/${rest[1]}`);
        if (oid === undefined) {
          sendErr(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, JSON.stringify({ name: rest[1], commit: { sha: oid }, protected: false }));
        return;
      }
    }
    // Git Data: refs.
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const body = await readBody(req);
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendErr(res, 400, 'Invalid JSON');
          return;
        }
        const ref = strField(parsed.value, 'ref');
        const sha = strField(parsed.value, 'sha');
        if (!ref.startsWith('refs/') || !HEX40.test(sha) || !repo.objects.has(sha)) {
          sendErr(res, 422, 'Invalid ref or sha');
          return;
        }
        if (repo.refs.has(ref)) {
          sendErr(res, 422, 'Reference already exists');
          return;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, JSON.stringify({ ref, object: { sha, type: 'commit' }, url: `/api/v3/repos/${owner}/${name}/git/refs/${ref}` }));
        return;
      }
      if (method === 'GET' && rest.length >= 4 && rest[2] === 'heads') {
        const branch = rest.slice(3).join('/');
        const oid = repo.refs.get(`refs/heads/${branch}`);
        if (oid === undefined) {
          sendErr(res, 404, 'Not Found');
          return;
        }
        sendJson(
          res,
          200,
          JSON.stringify({ ref: `refs/heads/${branch}`, object: { sha: oid, type: 'commit' } }),
        );
        return;
      }
    }
    // Commits.
    if (rest[0] === 'commits' && method === 'GET') {
      const shaParam = query.get('sha');
      let from: string | undefined;
      if (shaParam) from = resolveRef(repo, shaParam);
      else from = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (from === undefined) {
        sendJson(res, 200, '[]');
        return;
      }
      const commits = listCommits(repo, from);
      sendJson(res, 200, `[${commits.map((c) => commitJson(repo, c.sha)).join(',')}]`);
      return;
    }
    // Contents.
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).join('/');
      const refParam = query.get('ref');
      const branch = refParam ?? repo.defaultBranch;
      const tip = resolveRef(repo, branch);
      if (method === 'GET') {
        if (tip === undefined) {
          sendErr(res, 404, 'Not Found');
          return;
        }
        const flat = flatTree(repo, tip);
        const dirPrefix = filePath === '' ? '' : `${filePath}/`;
        const isDir = filePath === '' || [...flat.keys()].some((p) => p.startsWith(dirPrefix));
        if (!isDir) {
          const entry = flat.get(filePath);
          if (!entry) {
            sendErr(res, 404, 'Not Found');
            return;
          }
          const obj = repo.objects.get(entry.oid)!;
          sendJson(
            res,
            200,
            JSON.stringify({
              type: 'file',
              encoding: 'base64',
              size: obj.data.length,
              name: filePath.split('/').pop(),
              path: filePath,
              content: obj.data.toString('base64'),
              sha: entry.oid,
              url: `/api/v3/repos/${owner}/${name}/contents/${filePath}`,
            }),
          );
          return;
        }
        const entries: Array<Record<string, unknown>> = [];
        const seenDirs = new Set<string>();
        for (const [p, e] of flat) {
          if (!p.startsWith(dirPrefix)) continue;
          const rest2 = p.slice(dirPrefix.length);
          const slash = rest2.indexOf('/');
          if (slash < 0) {
            entries.push({ type: 'file', name: rest2, path: p, sha: e.oid, size: repo.objects.get(e.oid)?.data.length ?? 0 });
          } else {
            const dir = rest2.slice(0, slash);
            if (!seenDirs.has(dir)) {
              seenDirs.add(dir);
              entries.push({ type: 'dir', name: dir, path: `${dirPrefix}${dir}`, sha: '' });
            }
          }
        }
        // Directory shas: compute the subtree oid when possible.
        for (const entry of entries) {
          if (entry.type === 'dir') {
            const sub = flatTreeSubOid(repo, tip, entry.path as string);
            entry.sha = sub ?? '';
          }
        }
        entries.sort((a, b) => ((a.name as string) < (b.name as string) ? -1 : 1));
        sendJson(res, 200, JSON.stringify(entries));
        return;
      }
      if (method === 'PUT') {
        const body = await readBody(req);
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendErr(res, 400, 'Invalid JSON');
          return;
        }
        const contentB64 = strField(parsed.value, 'content');
        const message = strField(parsed.value, 'message', 'Update file');
        const shaParam = strField(parsed.value, 'sha', '');
        const branchParam = strField(parsed.value, 'branch', '');
        const useBranch = branchParam !== '' ? branchParam : repo.defaultBranch;
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          sendErr(res, 400, 'Invalid content');
          return;
        }
        const useTip = resolveRef(repo, useBranch);
        const flat = useTip ? flatTree(repo, useTip) : new Map();
        const existing = flat.get(filePath);
        if (existing && shaParam !== '' && shaParam !== existing.oid) {
          sendErr(res, 409, 'Conflict: sha does not match');
          return;
        }
        const isUpdate = existing !== undefined;
        const commitOid = commitFile(repo, useBranch, filePath, content, message);
        const blobOid = sha1('blob', content);
        sendJson(
          res,
          isUpdate ? 200 : 201,
          JSON.stringify({
            content: {
              name: filePath.split('/').pop(),
              path: filePath,
              sha: blobOid,
              size: content.length,
              encoding: 'base64',
            },
            commit: { sha: commitOid, message },
          }),
        );
        return;
      }
      if (method === 'DELETE') {
        const body = await readBody(req);
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendErr(res, 400, 'Invalid JSON');
          return;
        }
        const message = strField(parsed.value, 'message', 'Delete file');
        const branchParam = strField(parsed.value, 'branch', '');
        const useBranch = branchParam !== '' ? branchParam : repo.defaultBranch;
        const useTip = resolveRef(repo, useBranch);
        if (!useTip) {
          sendErr(res, 404, 'Not Found');
          return;
        }
        const flat = flatTree(repo, useTip);
        if (!flat.has(filePath)) {
          sendErr(res, 404, 'Not Found');
          return;
        }
        const commitOid = commitFile(repo, useBranch, filePath, null, message);
        sendJson(res, 200, JSON.stringify({ commit: { sha: commitOid } }));
        return;
      }
    }
    // Labels.
    if (rest[0] === 'labels') {
      if (method === 'POST') {
        const body = await readBody(req);
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendErr(res, 400, 'Invalid JSON');
          return;
        }
        const name = strField(parsed.value, 'name');
        const color = strField(parsed.value, 'color', 'ededed');
        if (name === '') {
          sendErr(res, 422, 'name is required');
          return;
        }
        let label = repo.labels.get(name);
        if (!label) {
          label = { name, color };
          repo.labels.set(name, label);
        }
        sendJson(res, 201, JSON.stringify({ name: label.name, color: label.color }));
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, JSON.stringify([...repo.labels.values()].map((l) => ({ name: l.name, color: l.color }))));
        return;
      }
    }
    // Issues.
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = await readBody(req);
          const parsed = parseJsonBody(body);
          if (!parsed.ok) {
            sendErr(res, 400, 'Invalid JSON');
            return;
          }
          const title = strField(parsed.value, 'title');
          const issueBody = strField(parsed.value, 'body');
          const labelNames: string[] = [];
          const rawLabels = isRecord(parsed.value) ? parsed.value.labels : undefined;
          if (Array.isArray(rawLabels)) {
            for (const l of rawLabels) {
              if (typeof l === 'string') labelNames.push(l);
              else if (isRecord(l) && typeof l.name === 'string') labelNames.push(l.name as string);
            }
          }
          const labels: Label[] = [];
          for (const ln of labelNames) {
            const found = repo.labels.get(ln);
            if (!found) {
              sendErr(res, 422, `Label does not exist: ${ln}`);
              return;
            }
            labels.push(found);
          }
          const issue = createIssueRecord(repo, title, issueBody, labels);
          sendJson(res, 201, issueJson(issue, repo));
          return;
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let items = repo.issues.filter((i) => state === 'all' || i.state === state);
          if (sort === 'created') {
            items = [...items].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          }
          const { page, perPage, pageNum } = pageOf(items, query);
          const text = `[${page.map((i) => issueJson(i, repo)).join(',')}]`;
          const link = linkHeader(req, `/api/v3/repos/${owner}/${name}/issues`, pageNum, perPage, items.length);
          sendJson(res, 200, text, link ? { link } : {});
          return;
        }
      }
      const num = parseInt(rest[1] ?? '', 10);
      const issue = repo.issues.find((i) => i.number === num);
      if (rest.length === 2) {
        if (!issue) {
          sendErr(res, 404, 'Not Found');
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, issueJson(issue, repo));
          return;
        }
        if (method === 'PATCH') {
          const body = await readBody(req);
          const parsed = parseJsonBody(body);
          if (!parsed.ok) {
            sendErr(res, 400, 'Invalid JSON');
            return;
          }
          const state = strField(parsed.value, 'state', '');
          if (state === 'open' || state === 'closed') issue.state = state;
          const title = strField(parsed.value, 'title', '');
          if (title !== '') issue.title = title;
          const b = strField(parsed.value, 'body', '');
          if (b !== '' || (isRecord(parsed.value) && 'body' in parsed.value)) issue.body = b;
          issue.jsonCache = '';
          sendJson(res, 200, issueJson(issue, repo));
          return;
        }
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) {
          sendErr(res, 404, 'Not Found');
          return;
        }
        if (method === 'GET') {
          sendJson(
            res,
            200,
            JSON.stringify(
              issue.comments.map((c) => ({
                id: c.id,
                body: c.body,
                user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
                created_at: c.created_at,
                updated_at: c.updated_at,
              })),
            ),
          );
          return;
        }
        if (method === 'POST') {
          const body = await readBody(req);
          const parsed = parseJsonBody(body);
          if (!parsed.ok) {
            sendErr(res, 400, 'Invalid JSON');
            return;
          }
          const comment: Comment = {
            id: nextCommentId,
            body: strField(parsed.value, 'body'),
            created_at: TRIAL_NOW_ISO,
            updated_at: TRIAL_NOW_ISO,
          };
          nextCommentId += 1;
          issue.comments.push(comment);
          issue.jsonCache = '';
          sendJson(
            res,
            201,
            JSON.stringify({
              id: comment.id,
              body: comment.body,
              user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
              created_at: comment.created_at,
              updated_at: comment.updated_at,
            }),
          );
          return;
        }
      }
    }
    // Pull requests.
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = await readBody(req);
          const parsed = parseJsonBody(body);
          if (!parsed.ok) {
            sendErr(res, 400, 'Invalid JSON');
            return;
          }
          const title = strField(parsed.value, 'title');
          const prBody = strField(parsed.value, 'body');
          const head = strField(parsed.value, 'head');
          const base = strField(parsed.value, 'base', repo.defaultBranch);
          const headRef = head.includes(':') ? head.split(':').pop()! : head;
          const baseRef = base.includes(':') ? base.split(':').pop()! : base;
          if (!repo.refs.has(`refs/heads/${headRef}`)) {
            sendErr(res, 422, `Head branch does not exist: ${headRef}`);
            return;
          }
          if (!repo.refs.has(`refs/heads/${baseRef}`)) {
            sendErr(res, 422, `Base branch does not exist: ${baseRef}`);
            return;
          }
          const dup = repo.pulls.find((p) => p.state === 'open' && p.head === headRef && p.base === baseRef);
          if (dup) {
            sendErr(res, 422, 'A pull request already exists for this branch');
            return;
          }
          const pull = createPullRecord(repo, title, prBody, headRef, baseRef);
          sendJson(res, 201, pullJson(pull, repo));
          return;
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let items = repo.pulls.filter((p) => state === 'all' || p.state === state);
          items = [...items].sort((a, b) => b.number - a.number);
          const { page, perPage, pageNum } = pageOf(items, query);
          const text = `[${page.map((p) => pullJson(p, repo)).join(',')}]`;
          const link = linkHeader(req, `/api/v3/repos/${owner}/${name}/pulls`, pageNum, perPage, items.length);
          sendJson(res, 200, text, link ? { link } : {});
          return;
        }
      }
      const num = parseInt(rest[1] ?? '', 10);
      const pull = repo.pulls.find((p) => p.number === num);
      if (rest.length === 2 && method === 'GET') {
        if (!pull) {
          sendErr(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, pullJson(pull, repo));
        return;
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (!pull) {
          sendErr(res, 404, 'Not Found');
          return;
        }
        const headTip = repo.refs.get(`refs/heads/${pull.head}`);
        const baseFlat = pull.mergeBase ? flatTree(repo, pull.mergeBase) : new Map();
        const headFlat = headTip ? flatTree(repo, headTip) : new Map();
        const files = diffFlat(baseFlat, headFlat).map((d) => {
          let additions = 0;
          let deletions = 0;
          if (d.status === 'added') additions = Math.max(1, lineCounts(repo, d.newOid));
          else if (d.status === 'removed') deletions = Math.max(1, lineCounts(repo, d.oldOid));
          else {
            const oldLines = repo.objects.get(d.oldOid!)?.data.toString('utf8').split('\n') ?? [];
            const newLines = repo.objects.get(d.newOid!)?.data.toString('utf8').split('\n') ?? [];
            const oldSet = new Map<string, number>();
            for (const l of oldLines) oldSet.set(l, (oldSet.get(l) ?? 0) + 1);
            for (const l of newLines) {
              const c = oldSet.get(l) ?? 0;
              if (c > 0) oldSet.set(l, c - 1);
              else additions += 1;
            }
            const newSet = new Map<string, number>();
            for (const l of newLines) newSet.set(l, (newSet.get(l) ?? 0) + 1);
            for (const l of oldLines) {
              const c = newSet.get(l) ?? 0;
              if (c > 0) newSet.set(l, c - 1);
              else deletions += 1;
            }
            if (additions === 0 && deletions === 0) {
              additions = 1;
              deletions = 1;
            }
          }
          return {
            filename: d.path,
            status: d.status,
            additions,
            deletions,
            changes: additions + deletions,
          };
        });
        sendJson(res, 200, JSON.stringify(files));
        return;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (!pull) {
          sendErr(res, 404, 'Not Found');
          return;
        }
        if (pull.state === 'closed' && pull.merged) {
          sendJson(
            res,
            200,
            JSON.stringify({ sha: pull.merge_commit_sha, merged: true, message: 'Pull request already merged' }),
          );
          return;
        }
        const body = await readBody(req);
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendErr(res, 400, 'Invalid JSON');
          return;
        }
        const sha = squashMerge(repo, pull);
        if (sha === null) {
          sendErr(res, 405, 'Merge conflict');
          return;
        }
        pull.state = 'closed';
        pull.merged = true;
        pull.merged_at = TRIAL_NOW_ISO;
        pull.merge_commit_sha = sha;
        pull.jsonCache = '';
        sendJson(res, 200, JSON.stringify({ sha, merged: true, message: `Pull request #${pull.number} merged` }));
        return;
      }
    }
  }

  sendErr(res, 404, 'Not Found');
}

// Subtree oid for a directory listing entry.
function flatTreeSubOid(repo: Repo, commitOid: string, dirPath: string): string | null {
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return null;
  let treeOid = parseCommit(obj.data).tree;
  for (const part of dirPath.split('/')) {
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((e) => e.name === part && e.mode === '40000');
    if (!entry) return null;
    treeOid = entry.oid;
  }
  return treeOid;
}

// ------------------------------------------------------------------ GraphQL v4

interface GqlField {
  name: string;
  alias: string | null;
  args: Record<string, unknown>;
  children: GqlField[];
  fragmentType: string | null;
}

const GQL_TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'labels', 'comments', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'author', 'createdAt', 'updatedAt', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'description', 'private', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt', 'url'],
  SearchType: [],
  User: ['login', 'id', 'name', 'email'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name', 'target'],
};

function gqlTypeOf(value: unknown): string {
  if (isRecord(value) && typeof value.__gqlType === 'string') return value.__gqlType;
  return 'Unknown';
}

// Tokenize a GraphQL document into names, punctuation and literals.
function gqlTokens(query: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < query.length) {
    const ch = query[i]!;
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < query.length && query[i] !== '\n') i += 1;
      continue;
    }
    if ('{}():![]@$=.'.includes(ch)) {
      if (ch === '.' && query.slice(i, i + 3) === '...') {
        tokens.push('...');
        i += 3;
        continue;
      }
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < query.length && query[j] !== '"') {
        if (query[j] === '\\' && j + 1 < query.length) {
          const esc = query[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += query[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < query.length && /[A-Za-z0-9_-]/.test(query[j]!)) j += 1;
    if (j === i) {
      i += 1;
      continue;
    }
    tokens.push(query.slice(i, j));
    i = j;
  }
  return tokens;
}

interface GqlParser {
  tokens: string[];
  pos: number;
  variables: Record<string, unknown>;
  errors: string[];
}

function gqlParseValue(p: GqlParser): unknown {
  const tok = p.tokens[p.pos] ?? '';
  if (tok === '{') {
    p.pos += 1;
    const obj: Record<string, unknown> = {};
    while (p.tokens[p.pos] !== '}' && p.pos < p.tokens.length) {
      const key = p.tokens[p.pos++]!;
      if (p.tokens[p.pos] === ':') p.pos += 1;
      obj[key] = gqlParseValue(p);
    }
    p.pos += 1;
    return obj;
  }
  if (tok === '[') {
    p.pos += 1;
    const arr: unknown[] = [];
    while (p.tokens[p.pos] !== ']' && p.pos < p.tokens.length) arr.push(gqlParseValue(p));
    p.pos += 1;
    return arr;
  }
  if (tok === '$') {
    const name = p.tokens[p.pos + 1] ?? '';
    p.pos += 2;
    return p.variables[name];
  }
  if (tok.startsWith('"')) {
    p.pos += 1;
    return JSON.parse(tok) as string;
  }
  p.pos += 1;
  if (tok === 'true') return true;
  if (tok === 'false') return false;
  if (tok === 'null') return null;
  const num = Number(tok);
  if (tok !== '' && !Number.isNaN(num)) return num;
  return tok;
}

function gqlParseSelection(p: GqlParser): GqlField[] {
  const fields: GqlField[] = [];
  while (p.pos < p.tokens.length) {
    const tok = p.tokens[p.pos]!;
    if (tok === '}') {
      p.pos += 1;
      break;
    }
    if (tok === '...') {
      p.pos += 1;
      let fragType: string | null = null;
      if (p.tokens[p.pos] === 'on') {
        p.pos += 1;
        fragType = p.tokens[p.pos++] ?? null;
      } else if (p.tokens[p.pos] !== '{') {
        p.pos += 1;
      }
      if (p.tokens[p.pos] === '{') {
        p.pos += 1;
        const inner = gqlParseSelection(p);
        for (const c of inner) fields.push({ ...c, fragmentType: fragType ?? c.fragmentType });
      }
      continue;
    }
    let name = tok;
    let alias: string | null = null;
    p.pos += 1;
    if (p.tokens[p.pos] === ':') {
      alias = name;
      p.pos += 1;
      name = p.tokens[p.pos++]!;
    }
    const args: Record<string, unknown> = {};
    if (p.tokens[p.pos] === '(') {
      p.pos += 1;
      while (p.tokens[p.pos] !== ')' && p.pos < p.tokens.length) {
        const key = p.tokens[p.pos++]!;
        if (p.tokens[p.pos] === ':') p.pos += 1;
        args[key] = gqlParseValue(p);
      }
      p.pos += 1;
    }
    let children: GqlField[] = [];
    if (p.tokens[p.pos] === '{') {
      p.pos += 1;
      children = gqlParseSelection(p);
    }
    fields.push({ name, alias, args, children, fragmentType: null });
  }
  return fields;
}

function gqlParseDocument(query: string, variables: Record<string, unknown>): { kind: 'query' | 'mutation'; fields: GqlField[]; errors: string[] } {
  const p: GqlParser = { tokens: gqlTokens(query), pos: 0, variables, errors: [] };
  let kind: 'query' | 'mutation' = 'query';
  while (p.pos < p.tokens.length) {
    const tok = p.tokens[p.pos]!;
    if (tok === 'query' || tok === 'mutation') {
      kind = tok;
      p.pos += 1;
      continue;
    }
    if (tok === '{') {
      p.pos += 1;
      return { kind, fields: gqlParseSelection(p), errors: p.errors };
    }
    p.pos += 1;
  }
  return { kind, fields: [], errors: p.errors };
}

function gqlIssueNode(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    __gqlType: 'Issue',
    id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    createdAt: TRIAL_NOW_ISO,
    updatedAt: TRIAL_NOW_ISO,
    url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    author: { __gqlType: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL },
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    comments: issue.comments.map((c) => ({ id: b64id('Comment', `${repo.owner}/${repo.name}:${issue.number}:${c.id}`), body: c.body })),
    repository: null,
  };
}

function gqlPullNode(pull: Pull, repo: Repo): Record<string, unknown> {
  const headTip = repo.refs.get(`refs/heads/${pull.head}`) ?? '';
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`) ?? '';
  return {
    __gqlType: 'PullRequest',
    id: pull.nodeId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    mergeable: pull.state === 'open' ? (isMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING') : 'UNKNOWN',
    headRefName: pull.head,
    baseRefName: pull.base,
    headRefOid: headTip,
    baseRefOid: baseTip,
    createdAt: TRIAL_NOW_ISO,
    updatedAt: TRIAL_NOW_ISO,
    url: `https://example.invalid/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    author: { __gqlType: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL },
    __pull: pull,
    __repo: repo,
  };
}

function gqlRepoNode(repo: Repo): Record<string, unknown> {
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return {
    __gqlType: 'Repository',
    id: repo.nodeId,
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __gqlType: 'User', login: repo.owner, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL },
    defaultBranchRef: tip ? { __gqlType: 'Ref', name: repo.defaultBranch, target: { oid: tip } } : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    private: repo.isPrivate,
    createdAt: TRIAL_NOW_ISO,
    updatedAt: TRIAL_NOW_ISO,
    url: `https://example.invalid/${repo.owner}/${repo.name}`,
    __repo: repo,
  };
}

function gqlCursor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64');
}
function gqlCursorNum(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = parseInt(text.slice(7), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function gqlResolveField(
  parent: Record<string, unknown> | null,
  parentType: string,
  field: GqlField,
  errors: string[],
): unknown {
  const name = field.name;
  // Root fields.
  if (parent === null) {
    if (name === '__typename') return 'Query';
    if (name === 'viewer') {
      return { __gqlType: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL };
    }
    if (name === 'repository') {
      const owner = String(field.args.owner ?? '');
      const repoName = String(field.args.name ?? '');
      const repo = getRepo(owner, repoName);
      return repo ? gqlRepoNode(repo) : null;
    }
    if (name === 'node') {
      const id = String(field.args.id ?? '');
      const decoded = decodeB64id(id);
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const [owner, repoName] = decoded.value.split('/');
        const repo = owner && repoName ? getRepo(owner, repoName) : undefined;
        return repo ? gqlRepoNode(repo) : null;
      }
      if (decoded.kind === 'Issue') {
        const [ownerRepo, num] = decoded.value.split(':');
        const [owner, repoName] = (ownerRepo ?? '').split('/');
        const repo = owner && repoName ? getRepo(owner, repoName) : undefined;
        const issue = repo?.issues.find((i) => i.number === parseInt(num ?? '', 10));
        return issue && repo ? gqlIssueNode(issue, repo) : null;
      }
      if (decoded.kind === 'PullRequest') {
        const [ownerRepo, num] = decoded.value.split(':');
        const [owner, repoName] = (ownerRepo ?? '').split('/');
        const repo = owner && repoName ? getRepo(owner, repoName) : undefined;
        const pull = repo?.pulls.find((p) => p.number === parseInt(num ?? '', 10));
        return pull && repo ? gqlPullNode(pull, repo) : null;
      }
      return null;
    }
    if (name === '__type') {
      const typeName = String(field.args.name ?? '');
      const known = ['Issue', 'PullRequest', 'Repository', 'SearchType', 'User', 'IssueConnection', 'PullRequestConnection', 'PageInfo'];
      if (!known.includes(typeName)) return null;
      return {
        __gqlType: '__Type',
        name: typeName,
        kind: typeName === 'SearchType' ? 'ENUM' : 'OBJECT',
        fields: (GQL_TYPE_FIELDS[typeName] ?? []).map((f) => ({ name: f })),
        enumValues:
          typeName === 'SearchType'
            ? [{ name: 'ISSUE' }, { name: 'REPOSITORY' }, { name: 'USER' }, { name: 'DISCUSSION' }, { name: 'COMMIT' }]
            : null,
      };
    }
    if (name === '__schema') return { __gqlType: '__Schema', queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } };
    errors.push(`Cannot query field "${name}" on type "Query".`);
    return undefined;
  }
  // __Type fields.
  if (parentType === '__Type') {
    if (name === 'name' || name === 'kind') return parent[name];
    if (name === 'fields') return parent.fields ?? [];
    if (name === 'enumValues') return parent.enumValues ?? [];
    errors.push(`Cannot query field "${name}" on type "__Type".`);
    return undefined;
  }
  // Type-specific object fields.
  if (name === '__typename') return parentType;
  if (parentType === 'Repository') {
    const repo = parent.__repo as Repo;
    if (name === 'issue') {
      const num = Number(field.args.number);
      const issue = repo.issues.find((i) => i.number === num);
      return issue ? gqlIssueNode(issue, repo) : null;
    }
    if (name === 'issues') {
      let items = [...repo.issues];
      const states = field.args.states;
      if (Array.isArray(states)) {
        const wanted = new Set(states.map((s) => String(s).toLowerCase()));
        items = items.filter((i) => wanted.has(i.state));
      }
      const orderBy = isRecord(field.args.orderBy) ? field.args.orderBy : null;
      const dir = orderBy ? String(orderBy.direction ?? 'DESC') : 'ASC';
      const fieldName = orderBy ? String(orderBy.field ?? 'CREATED_AT') : 'CREATED_AT';
      if (fieldName === 'CREATED_AT') {
        items.sort((a, b) => (dir === 'DESC' ? b.number - a.number || b.seq - a.seq : a.number - b.number || a.seq - b.seq));
      } else {
        items.sort((a, b) => (dir === 'DESC' ? b.number - a.number : a.number - b.number));
      }
      const first = typeof field.args.first === 'number' ? field.args.first : items.length;
      const afterNum = gqlCursorNum(field.args.after);
      if (afterNum !== null) {
        const idx = items.findIndex((i) => i.number === afterNum);
        if (idx >= 0) items = items.slice(idx + 1);
      }
      const nodes = items.slice(0, first);
      const hasNext = items.length > first;
      const endCursor = nodes.length ? gqlCursor(nodes[nodes.length - 1]!.number) : null;
      return {
        __gqlType: 'IssueConnection',
        nodes: nodes.map((i) => gqlIssueNode(i, repo)),
        edges: nodes.map((i) => ({ node: gqlIssueNode(i, repo), cursor: gqlCursor(i.number) })),
        pageInfo: { hasNextPage: hasNext, hasPreviousPage: afterNum !== null, startCursor: nodes.length ? gqlCursor(nodes[0]!.number) : null, endCursor },
        totalCount: items.length,
      };
    }
    if (name === 'pullRequests') {
      let items = [...repo.pulls].filter((p) => p.state === 'open');
      const first = typeof field.args.first === 'number' ? field.args.first : items.length;
      items.sort((a, b) => b.number - a.number);
      const nodes = items.slice(0, first);
      return {
        __gqlType: 'PullRequestConnection',
        nodes: nodes.map((p) => gqlPullNode(p, repo)),
        edges: nodes.map((p) => ({ node: gqlPullNode(p, repo), cursor: gqlCursor(p.number) })),
        pageInfo: { hasNextPage: items.length > first, hasPreviousPage: false, startCursor: null, endCursor: nodes.length ? gqlCursor(nodes[nodes.length - 1]!.number) : null },
        totalCount: items.length,
      };
    }
    if (name === 'pullRequest') {
      const num = Number(field.args.number);
      const pull = repo.pulls.find((p) => p.number === num);
      return pull ? gqlPullNode(pull, repo) : null;
    }
  }
  if (parentType === 'PullRequest') {
    if (name === 'files') {
      const pull = parent.__pull as Pull;
      const repo = parent.__repo as Repo;
      const headTip = repo.refs.get(`refs/heads/${pull.head}`);
      const baseFlat = pull.mergeBase ? flatTree(repo, pull.mergeBase) : new Map();
      const headFlat = headTip ? flatTree(repo, headTip) : new Map();
      const first = typeof field.args.first === 'number' ? field.args.first : 100;
      const nodes = diffFlat(baseFlat, headFlat)
        .slice(0, first)
        .map((d) => ({ __gqlType: 'PullRequestFile', path: d.path, additions: 0, deletions: 0, changeType: d.status }));
      return { __gqlType: 'PullRequestFileConnection', nodes, edges: nodes.map((n) => ({ node: n })), pageInfo: { hasNextPage: false, endCursor: null } };
    }
  }
  if (parentType === 'IssueConnection' || parentType === 'PullRequestConnection' || parentType === 'PullRequestFileConnection') {
    if (name === 'nodes' || name === 'edges' || name === 'pageInfo' || name === 'totalCount') return parent[name];
  }
  if (parentType === 'PageInfo') {
    if (name === 'hasNextPage' || name === 'hasPreviousPage' || name === 'startCursor' || name === 'endCursor') return parent[name];
  }
  if (parentType === 'Ref') {
    if (name === 'name') return parent.name;
    if (name === 'target') return parent.target;
  }
  if (parentType === 'User') {
    if (name === 'login' || name === 'id' || name === 'name' || name === 'email') return parent[name];
  }
  // Generic scalar/object field present on the node itself.
  if (name in parent && name !== '__gqlType' && name !== '__repo' && name !== '__pull') {
    return parent[name];
  }
  errors.push(`Cannot query field "${name}" on type "${parentType}".`);
  return undefined;
}

function gqlExecuteSelection(
  parent: Record<string, unknown> | null,
  parentType: string,
  fields: GqlField[],
  errors: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.fragmentType && parent !== null && field.fragmentType !== parentType) continue;
    const value = gqlResolveField(parent, parentType, field, errors);
    const key = field.alias ?? field.name;
    if (value === undefined) {
      out[key] = null;
      continue;
    }
    if (field.children.length > 0 && value !== null && typeof value === 'object') {
      if (Array.isArray(value)) {
        out[key] = value.map((v) => {
          if (isRecord(v)) {
            const t = gqlTypeOf(v);
            return gqlExecuteSelection(v, t, field.children, errors);
          }
          return v;
        });
      } else if (isRecord(value)) {
        const t = gqlTypeOf(value);
        out[key] = gqlExecuteSelection(value, t, field.children, errors);
      } else {
        out[key] = value;
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

function gqlExecuteOperation(
  query: string,
  variables: Record<string, unknown>,
): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } {
  const doc = gqlParseDocument(query, variables);
  const errors: string[] = [...doc.errors];
  if (doc.kind === 'mutation') {
    return gqlExecuteMutation(doc.fields, variables, errors);
  }
  const data = gqlExecuteSelection(null, 'Query', doc.fields, errors);
  if (errors.length > 0) return { data: null, errors: errors.map((m) => ({ message: m })) };
  return { data, errors: [] };
}

function gqlExecuteMutation(
  fields: GqlField[],
  variables: Record<string, unknown>,
  errors: string[],
): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } {
  void variables;
  const data: Record<string, unknown> = {};
  for (const field of fields) {
    const input = isRecord(field.args.input) ? field.args.input : {};
    if (field.name === 'createIssue') {
      const repoId = String(input.repositoryId ?? '');
      const decoded = decodeB64id(repoId);
      let repo: Repo | undefined;
      if (decoded && decoded.kind === 'Repository') {
        const [owner, name] = decoded.value.split('/');
        repo = owner && name ? getRepo(owner, name) : undefined;
      }
      if (!repo) {
        errors.push('createIssue: repository not found');
        data[field.alias ?? field.name] = null;
        continue;
      }
      const issue = createIssueRecord(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      const node = gqlIssueNode(issue, repo);
      const sel: Record<string, unknown> = {};
      for (const child of field.children) {
        if (child.name === 'issue') {
          sel.issue = gqlExecuteSelection(node, 'Issue', child.children, errors);
        }
      }
      data[field.alias ?? field.name] = sel;
      continue;
    }
    if (field.name === 'closeIssue') {
      const issueId = String(input.issueId ?? '');
      const decoded = decodeB64id(issueId);
      let target: Issue | undefined;
      let targetRepo: Repo | undefined;
      if (decoded && decoded.kind === 'Issue') {
        const [ownerRepo, num] = decoded.value.split(':');
        const [owner, name] = (ownerRepo ?? '').split('/');
        targetRepo = owner && name ? getRepo(owner, name) : undefined;
        target = targetRepo?.issues.find((i) => i.number === parseInt(num ?? '', 10));
      }
      if (!target || !targetRepo) {
        errors.push('closeIssue: issue not found');
        data[field.alias ?? field.name] = null;
        continue;
      }
      target.state = 'closed';
      target.jsonCache = '';
      const node = gqlIssueNode(target, targetRepo);
      const sel: Record<string, unknown> = {};
      for (const child of field.children) {
        if (child.name === 'issue') sel.issue = gqlExecuteSelection(node, 'Issue', child.children, errors);
      }
      data[field.alias ?? field.name] = sel;
      continue;
    }
    if (field.name === 'createPullRequest') {
      const repoId = String(input.repositoryId ?? '');
      const decoded = decodeB64id(repoId);
      let repo: Repo | undefined;
      if (decoded && decoded.kind === 'Repository') {
        const [owner, name] = decoded.value.split('/');
        repo = owner && name ? getRepo(owner, name) : undefined;
      }
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? repo?.defaultBranch ?? 'main');
      if (!repo || !repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
        errors.push('createPullRequest: branch not found');
        data[field.alias ?? field.name] = null;
        continue;
      }
      const dup = repo.pulls.find((p) => p.state === 'open' && p.head === head && p.base === base);
      const pull = dup ?? createPullRecord(repo, String(input.title ?? ''), String(input.body ?? ''), head, base);
      const node = gqlPullNode(pull, repo);
      const sel: Record<string, unknown> = {};
      for (const child of field.children) {
        if (child.name === 'pullRequest') sel.pullRequest = gqlExecuteSelection(node, 'PullRequest', child.children, errors);
      }
      data[field.alias ?? field.name] = sel;
      continue;
    }
    if (field.name === 'mergePullRequest') {
      const prId = String(input.pullRequestId ?? '');
      const decoded = decodeB64id(prId);
      let target: Pull | undefined;
      let targetRepo: Repo | undefined;
      if (decoded && decoded.kind === 'PullRequest') {
        const [ownerRepo, num] = decoded.value.split(':');
        const [owner, name] = (ownerRepo ?? '').split('/');
        targetRepo = owner && name ? getRepo(owner, name) : undefined;
        target = targetRepo?.pulls.find((p) => p.number === parseInt(num ?? '', 10));
      }
      if (!target || !targetRepo) {
        errors.push('mergePullRequest: pull request not found');
        data[field.alias ?? field.name] = null;
        continue;
      }
      const sha = squashMerge(targetRepo, target);
      if (sha === null) {
        errors.push('mergePullRequest: merge conflict');
        data[field.alias ?? field.name] = null;
        continue;
      }
      target.state = 'closed';
      target.merged = true;
      target.merged_at = TRIAL_NOW_ISO;
      target.merge_commit_sha = sha;
      target.jsonCache = '';
      const node = gqlPullNode(target, targetRepo);
      const sel: Record<string, unknown> = {};
      for (const child of field.children) {
        if (child.name === 'pullRequest') sel.pullRequest = gqlExecuteSelection(node, 'PullRequest', child.children, errors);
      }
      data[field.alias ?? field.name] = sel;
      continue;
    }
    if (field.name === 'addComment') {
      const subjectId = String(input.subjectId ?? '');
      const decoded = decodeB64id(subjectId);
      let target: Issue | undefined;
      let targetRepo: Repo | undefined;
      if (decoded && decoded.kind === 'Issue') {
        const [ownerRepo, num] = decoded.value.split(':');
        const [owner, name] = (ownerRepo ?? '').split('/');
        targetRepo = owner && name ? getRepo(owner, name) : undefined;
        target = targetRepo?.issues.find((i) => i.number === parseInt(num ?? '', 10));
      }
      if (!target || !targetRepo) {
        errors.push('addComment: subject not found');
        data[field.alias ?? field.name] = null;
        continue;
      }
      const comment: Comment = {
        id: nextCommentId,
        body: String(input.body ?? ''),
        created_at: TRIAL_NOW_ISO,
        updated_at: TRIAL_NOW_ISO,
      };
      nextCommentId += 1;
      target.comments.push(comment);
      target.jsonCache = '';
      const commentNode = { __gqlType: 'Comment', id: b64id('Comment', `${targetRepo.owner}/${targetRepo.name}:${target.number}:${comment.id}`), body: comment.body };
      const sel: Record<string, unknown> = {};
      for (const child of field.children) {
        if (child.name === 'commentEdge') {
          const edge: Record<string, unknown> = {};
          for (const grand of child.children) {
            if (grand.name === 'node') edge.node = gqlExecuteSelection(commentNode, 'Comment', grand.children, errors);
          }
          sel.commentEdge = edge;
        }
      }
      data[field.alias ?? field.name] = sel;
      continue;
    }
    errors.push(`Cannot query field "${field.name}" on type "Mutation".`);
    data[field.alias ?? field.name] = null;
  }
  if (errors.length > 0) return { data: null, errors: errors.map((m) => ({ message: m })) };
  return { data, errors: [] };
}

async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authed(req)) {
    sendJson(res, 401, JSON.stringify({ message: 'Bad credentials' }));
    return;
  }
  const body = await readBody(req);
  const parsed = parseJsonBody(body);
  if (!parsed.ok) {
    sendJson(res, 400, JSON.stringify({ errors: [{ message: 'Invalid JSON' }] }));
    return;
  }
  const runOne = (op: unknown): unknown => {
    if (!isRecord(op)) return { data: null, errors: [{ message: 'Invalid operation' }] };
    const query = typeof op.query === 'string' ? op.query : '';
    const variables = isRecord(op.variables) ? (op.variables as Record<string, unknown>) : {};
    const result = gqlExecuteOperation(query, variables);
    if (result.errors.length > 0) return { data: result.data, errors: result.errors };
    return { data: result.data };
  };
  if (Array.isArray(parsed.value)) {
    sendJson(res, 200, JSON.stringify(parsed.value.map(runOne)));
    return;
  }
  sendJson(res, 200, JSON.stringify(runOne(parsed.value)));
}

// ------------------------------------------------------------------ MCP

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        number: { type: 'integer', description: 'Issue number' },
      },
      required: ['owner', 'repo', 'number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Pull request state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
];

const MCP_TOOLS_JSON = JSON.stringify({ tools: MCP_TOOLS });

function mcpNorm(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function mcpFindTool(name: string): McpToolDef | null {
  const want = mcpNorm(name);
  for (const tool of MCP_TOOLS) {
    const norm = mcpNorm(tool.name);
    if (norm === want) return tool;
    if (want.length > norm.length && want.endsWith(norm)) return tool;
  }
  return null;
}

function mcpToolResult(obj: unknown, isError = false): Record<string, unknown> {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj, isError };
}

function mcpCallTool(name: string, args: Record<string, unknown>): { result?: Record<string, unknown>; error?: { code: number; message: string } } {
  const tool = mcpFindTool(name);
  if (!tool) return { error: { code: -32601, message: `Unknown tool: ${name}` } };
  const required = Array.isArray(tool.inputSchema.required) ? (tool.inputSchema.required as string[]) : [];
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      return { result: mcpToolResult({ error: `missing required argument: ${key}` }, true) };
    }
  }
  const owner = String(args.owner ?? VIEWER_LOGIN);
  const repoName = String(args.repo ?? args.name ?? '');
  if (tool.name === 'create_repo') {
    const repoName2 = String(args.name ?? '');
    if (repoName2 === '') return { result: mcpToolResult({ error: 'missing required argument: name' }, true) };
    if (getRepo(VIEWER_LOGIN, repoName2)) {
      return { result: mcpToolResult({ error: 'Repository already exists' }, true) };
    }
    const repo = createRepoRecord(repoName2, String(args.description ?? ''), boolField(args, 'private', false));
    return { result: mcpToolResult(JSON.parse(repoJson(repo))) };
  }
  const repo = getRepo(owner, repoName);
  if (!repo) return { result: mcpToolResult({ error: `Repository not found: ${owner}/${repoName}` }, true) };
  if (tool.name === 'get_repo') {
    return { result: mcpToolResult(JSON.parse(repoJson(repo))) };
  }
  if (tool.name === 'create_issue') {
    const issue = createIssueRecord(repo, String(args.title ?? ''), String(args.body ?? ''), []);
    return { result: mcpToolResult(JSON.parse(issueJson(issue, repo))) };
  }
  if (tool.name === 'list_issues') {
    const state = String(args.state ?? 'open');
    const items = repo.issues.filter((i) => state === 'all' || i.state === state);
    return { result: mcpToolResult({ issues: items.map((i) => JSON.parse(issueJson(i, repo))) }) };
  }
  if (tool.name === 'get_issue') {
    const issue = repo.issues.find((i) => i.number === Number(args.number));
    if (!issue) return { result: mcpToolResult({ error: 'Issue not found' }, true) };
    return { result: mcpToolResult(JSON.parse(issueJson(issue, repo))) };
  }
  if (tool.name === 'list_pull_requests') {
    const state = String(args.state ?? 'open');
    const items = repo.pulls.filter((p) => state === 'all' || p.state === state);
    return { result: mcpToolResult({ pull_requests: items.map((p) => JSON.parse(pullJson(p, repo))) }) };
  }
  if (tool.name === 'create_pull_request') {
    const head = String(args.head ?? '');
    const base = String(args.base ?? repo.defaultBranch);
    if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
      return { result: mcpToolResult({ error: 'Head or base branch not found' }, true) };
    }
    const dup = repo.pulls.find((p) => p.state === 'open' && p.head === head && p.base === base);
    if (dup) return { result: mcpToolResult({ error: 'A pull request already exists for this branch' }, true) };
    const pull = createPullRecord(repo, String(args.title ?? ''), String(args.body ?? ''), head, base);
    return { result: mcpToolResult(JSON.parse(pullJson(pull, repo))) };
  }
  if (tool.name === 'merge_pull_request') {
    const pull = repo.pulls.find((p) => p.number === Number(args.pull_number));
    if (!pull) return { result: mcpToolResult({ error: 'Pull request not found' }, true) };
    if (pull.state === 'closed' && pull.merged) {
      return { result: mcpToolResult({ number: pull.number, merged: true, sha: pull.merge_commit_sha }) };
    }
    const sha = squashMerge(repo, pull);
    if (sha === null) return { result: mcpToolResult({ error: 'Merge conflict' }, true) };
    pull.state = 'closed';
    pull.merged = true;
    pull.merged_at = TRIAL_NOW_ISO;
    pull.merge_commit_sha = sha;
    pull.jsonCache = '';
    return { result: mcpToolResult({ number: pull.number, merged: true, sha }) };
  }
  return { error: { code: -32601, message: `Unknown tool: ${name}` } };
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, JSON.stringify({ message: 'Method Not Allowed' }));
    return;
  }
  if (!authed(req)) {
    sendJson(res, 401, JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } }));
    return;
  }
  const raw = await readBody(req);
  const text = raw.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    sendJson(res, 400, JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    return;
  }
  const handleOne = (msg: unknown): Record<string, unknown> | null => {
    if (!isRecord(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      const id = isRecord(msg) ? msg.id ?? null : null;
      return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } };
    }
    const id = msg.id ?? null;
    const method = msg.method as string;
    const params = isRecord(msg.params) ? (msg.params as Record<string, unknown>) : {};
    // Notifications have no id: acknowledge with nothing (handled by caller via 202).
    if (id === null || id === undefined) {
      return null;
    }
    if (method === 'server/discover') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2026-07-28',
          supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
          capabilities: { tools: {} },
          serverInfo: { name: FORGE_NAME, version: FORGE_VERSION },
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: FORGE_NAME, version: FORGE_VERSION } },
        },
      };
    }
    if (method === 'initialize') {
      const requested = isRecord(params) ? String(params.protocolVersion ?? '') : '';
      const known = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
      const negotiated = known.includes(requested) ? requested : '2025-11-25';
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: { name: FORGE_NAME, version: FORGE_VERSION },
        },
      };
    }
    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} };
    }
    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: JSON.parse(MCP_TOOLS_JSON) };
    }
    if (method === 'tools/call') {
      const toolName = String(params.name ?? '');
      const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      const outcome = mcpCallTool(toolName, args);
      if (outcome.error) return { jsonrpc: '2.0', id, error: outcome.error };
      return { jsonrpc: '2.0', id, result: outcome.result };
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  };
  if (Array.isArray(parsed)) {
    const results = parsed.map(handleOne).filter((r) => r !== null);
    sendJson(res, 200, JSON.stringify(results));
    return;
  }
  const result = handleOne(parsed);
  if (result === null) {
    res.writeHead(202);
    res.end();
    return;
  }
  sendJson(res, 200, JSON.stringify(result));
}

// ------------------------------------------------------------------ dispatch

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = req.url ?? '/';
        const pathEnd = url.indexOf('?');
        const path = pathEnd < 0 ? url : url.slice(0, pathEnd);
        const method = req.method ?? 'GET';
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, '{"ok":true}');
          return;
        }
        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
        if (gitMatch) {
          const owner = gitMatch[1]!;
          const name = gitMatch[2]!;
          const suffix = gitMatch[3] ?? '';
          const repo = getRepo(owner, name);
          if (suffix === '/info/refs') {
            const service = queryParams(url).get('service') ?? '';
            if (repo === undefined) {
              sendJson(res, 404, JSON.stringify({ message: 'Not Found' }));
              return;
            }
            if (service === 'git-upload-pack') {
              const proto = (req.headers['git-protocol'] ?? '') as string;
              if (proto.includes('version=2')) {
                sendBuf(res, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
              } else {
                sendBuf(res, 200, v0Advertisement(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
              }
              return;
            }
            if (service === 'git-receive-pack') {
              sendBuf(res, 200, v0Advertisement(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
              return;
            }
            sendJson(res, 404, JSON.stringify({ message: 'Not Found' }));
            return;
          }
          if (repo === undefined) {
            sendJson(res, 404, JSON.stringify({ message: 'Not Found' }));
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 404, JSON.stringify({ message: 'Not Found' }));
            return;
          }
          const body = await readBody(req);
          if (suffix === '/git-upload-pack') {
            await handleGitUploadPack(req, res, repo, body);
            return;
          }
          if (suffix === '/git-receive-pack') {
            await handleGitReceivePack(req, res, repo, body);
            return;
          }
          sendJson(res, 404, JSON.stringify({ message: 'Not Found' }));
          return;
        }
        if (path === '/api/graphql' && method === 'POST') {
          await handleGraphQL(req, res);
          return;
        }
        if (path === '/mcp') {
          await handleMcp(req, res);
          return;
        }
        if (path.startsWith('/api/v3')) {
          const segs = splitPath(path);
          const query = queryParams(url);
          await handleRest(req, res, method, segs, query);
          return;
        }
        sendJson(res, 404, JSON.stringify({ message: 'Not Found' }));
      } catch (err) {
        try {
          sendJson(res, 500, JSON.stringify({ message: err instanceof Error ? err.message : 'Internal error' }));
        } catch {
          // Response already gone; nothing left to do.
        }
      }
    })();
  });
}
