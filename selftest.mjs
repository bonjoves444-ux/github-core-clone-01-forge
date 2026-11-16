// selftest.mjs — black-box tests for the caching edge (edge.ts + gitpack.ts).
//
// Runs the edge in front of a small fake forge and asserts the contract the
// real trial depends on: repeatable answers are served from cache, mutations
// invalidate or splice, unauthenticated requests always reach the forge, and
// concurrent identical clones collapse onto one real clone. Run it with:
//   node --experimental-strip-types selftest.mjs
// Exit 0 when every test passes, 1 otherwise. It never touches the network
// beyond loopback and never touches the real forge.

import http from 'node:http';
import { createHash } from 'node:crypto';
import { createEdgeServer } from './edge.ts';

const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);
const OID_C = 'c'.repeat(40);

function pkt(payload) {
  const body = Buffer.from(payload, 'utf8');
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii'), body]);
}
function flush() {
  return Buffer.from('0000', 'ascii');
}
function advReceive(tips) {
  const caps = 'symref=HEAD:refs/heads/main report-status report-status-v2 side-band-64k delete-refs agent=git/2.40';
  const parts = [pkt('# service=git-receive-pack\n'), flush()];
  const names = [...tips.keys()].sort();
  if (names.length === 0) {
    parts.push(pkt(`${'0'.repeat(40)} capabilities^{}\0${caps}`));
  } else {
    for (const ref of names) parts.push(pkt(`${tips.get(ref)} ${ref}\0${caps}`));
    parts.push(pkt(`${tips.get('refs/heads/main') ?? '0'.repeat(40)} HEAD`));
  }
  parts.push(flush());
  return Buffer.concat(parts);
}
function advUpload() {
  return Buffer.concat([
    pkt('# service=git-upload-pack\n'),
    flush(),
    pkt('version 2\n'),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow wait-for-done filter\n'),
    pkt('object-format=sha1\n'),
    pkt('agent=github-forge/1.0.0\n'),
    flush(),
  ]);
}
function lsRefs(tip) {
  return Buffer.concat([pkt(`${tip} HEAD\n`), pkt(`${tip} refs/heads/main\n`), flush()]);
}
function fetchPack() {
  const head = Buffer.concat([Buffer.from('PACK', 'ascii'), Buffer.from([0, 0, 0, 2]), Buffer.from([0, 0, 0, 0])]);
  const trailer = createHash('sha1').update(head).digest();
  const pack = Buffer.concat([head, trailer]);
  return Buffer.concat([pkt(Buffer.concat([Buffer.from([0x01]), pack])), flush()]);
}
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.concat(chunks)));
  });
}
function parseFirstLine(body) {
  const head = body.toString('ascii', 0, 4);
  const len = parseInt(head, 16);
  if (Number.isNaN(len) || len < 4 || len > body.length) return '';
  return body.toString('utf8', 4, len);
}

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const counts = { issueGets: 0, advGets: 0, uploadPosts: 0, receivePosts: 0 };
const tips = new Map([['refs/heads/main', OID_A]]);
const issues = new Map([[1, { number: 1, title: 'bench issue', body: 'hello' }]]);

async function fakeForge(req, res) {
  const url = req.url ?? '/';
  const auth = req.headers.authorization;
  const authed = typeof auth === 'string' && auth.startsWith('Bearer ');
  const json = (status, obj) => {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'x-github-request-id': `req-fake-${counts.issueGets + counts.advGets}` });
    res.end(body);
  };
  if (!authed) {
    json(401, { message: 'requires authentication' });
    return;
  }
  const issueMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/([0-9]+)$/.exec(url.split('?')[0]);
  if (req.method === 'GET' && issueMatch) {
    counts.issueGets += 1;
    const n = Number(issueMatch[3]);
    const issue = issues.get(n);
    if (!issue) { json(404, { message: 'not found' }); return; }
    json(200, { ...issue, calls: counts.issueGets });
    return;
  }
  if (req.method === 'POST' && url.endsWith('/issues')) {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const n = Math.max(0, ...issues.keys()) + 1;
    issues.set(n, { number: n, title: body.title ?? '', body: body.body ?? '' });
    json(201, issues.get(n));
    return;
  }
  if (url.includes('.git/info/refs')) {
    counts.advGets += 1;
    const service = url.includes('git-upload-pack') ? 'git-upload-pack' : 'git-receive-pack';
    const body = service === 'git-upload-pack' ? advUpload() : advReceive(tips);
    res.writeHead(200, { 'content-type': `application/x-${service}-advertisement`, 'content-length': body.length });
    res.end(body);
    return;
  }
  if (req.method === 'POST' && url.endsWith('/git-upload-pack')) {
    counts.uploadPosts += 1;
    const body = await readBody(req);
    const first = parseFirstLine(body);
    const answer = first.startsWith('command=ls-refs') ? lsRefs(tips.get('refs/heads/main')) : fetchPack();
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': answer.length });
    res.end(answer);
    return;
  }
  if (req.method === 'POST' && url.endsWith('/git-receive-pack')) {
    counts.receivePosts += 1;
    const body = await readBody(req);
    const first = parseFirstLine(body);
    const nul = first.indexOf('\0');
    const [oldOid, newOid, ref] = (nul >= 0 ? first.slice(0, nul) : first).split(' ');
    const current = tips.get(ref);
    let ok = false;
    if (oldOid === '0'.repeat(40) && current === undefined) {
      tips.set(ref, newOid);
      ok = true;
    } else if (current !== undefined && oldOid === current) {
      tips.set(ref, newOid);
      ok = true;
    }
    const report = Buffer.concat([
      pkt('unpack ok\n'),
      ok ? pkt(`ok ${ref}\n`) : pkt(`ng ${ref} non-fast-forward\n`),
      flush(),
    ]);
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': report.length });
    res.end(report);
    return;
  }
  json(404, { message: 'not found' });
}

const appServer = http.createServer(fakeForge);
const { server, loopback, edge } = createEdgeServer(appServer);
await new Promise((r) => loopback.listen(0, '127.0.0.1', r));
edge.setLoopbackPort(loopback.address().port);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const H = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
const noAuth = { 'Content-Type': 'application/json' };
async function get(path, headers = H) {
  const r = await fetch(base + path, { headers });
  return { status: r.status, text: await r.text(), headers: r.headers };
}
async function post(path, body, headers = H) {
  const r = await fetch(base + path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: r.status, text: await r.text(), buf: null };
}
async function postRaw(path, bodyBuf) {
  const r = await fetch(base + path, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/x-git-upload-pack-request', 'Git-Protocol': 'version=2' },
    body: bodyBuf,
  });
  return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) };
}
const lsBody = Buffer.concat([pkt('command=ls-refs\n'), pkt('agent=test/1.0\n'), pkt('object-format=sha1\n'), flush(), pkt('peel\n'), flush()]);
const fetchBody = Buffer.concat([pkt('command=fetch\n'), pkt('object-format=sha1\n'), flush(), pkt(`want ${OID_A}\n`), pkt('done\n')]);
const fetchBodyB = Buffer.concat([pkt('command=fetch\n'), pkt('object-format=sha1\n'), flush(), pkt(`want ${OID_B}\n`), pkt('done\n')]);

// 1. Issue GET is cached: five reads, one forge call, identical bytes.
{
  const before = counts.issueGets;
  const bodies = [];
  for (let i = 0; i < 5; i++) bodies.push((await get('/api/v3/repos/o/r/issues/1')).text);
  check('issue GET cached', counts.issueGets === before + 1 && bodies.every((b) => b === bodies[0]), `forge calls ${counts.issueGets - before}`);
}
// 2. Unauthenticated GETs reach the forge (401) and never populate the cache:
// an authenticated read of the same issue afterwards still calls the forge once.
{
  await post('/api/v3/repos/o/r/issues', { title: 'second', body: 'x' });
  const before = counts.issueGets;
  const a = await get('/api/v3/repos/o/r/issues/2', noAuth);
  const b = await get('/api/v3/repos/o/r/issues/2', noAuth);
  const c = await get('/api/v3/repos/o/r/issues/2');
  const d = await get('/api/v3/repos/o/r/issues/2');
  check('unauthenticated GET not cached', a.status === 401 && b.status === 401 && c.status === 200 && counts.issueGets === before + 1, `status ${a.status}/${b.status}/${c.status}, calls ${counts.issueGets - before}`);
}
// 3. A mutation clears the issue cache.
{
  await post('/api/v3/repos/o/r/issues', { title: 'second', body: 'x' });
  const before = counts.issueGets;
  await get('/api/v3/repos/o/r/issues/1');
  check('POST invalidates issue cache', counts.issueGets === before + 1, `calls ${counts.issueGets - before}`);
}
// 4. Upload-pack advertisement is cached.
{
  const before = counts.advGets;
  for (let i = 0; i < 3; i++) await get('/o/r.git/info/refs?service=git-upload-pack');
  check('upload-pack advertisement cached', counts.advGets === before + 1, `calls ${counts.advGets - before}`);
}
// 5. Concurrent identical upload-pack POSTs collapse onto one forge call.
{
  const before = counts.uploadPosts;
  await Promise.all(Array.from({ length: 10 }, () => postRaw('/o/r.git/git-upload-pack', lsBody)));
  const afterLs = counts.uploadPosts;
  await Promise.all(Array.from({ length: 10 }, () => postRaw('/o/r.git/git-upload-pack', fetchBody)));
  await postRaw('/o/r.git/git-upload-pack', fetchBodyB);
  check('upload-pack singleflight', afterLs === before + 1 && counts.uploadPosts === before + 3, `calls ${counts.uploadPosts - before}`);
}
// 6. A push splices the cached receive-pack advertisement in place.
{
  const before = counts.advGets;
  await get('/o/r.git/info/refs?service=git-receive-pack');
  const advCalls = counts.advGets - before;
  const pushBody = Buffer.concat([pkt(`${OID_A} ${OID_B} refs/heads/main\0report-status side-band-64k\n`), flush(), Buffer.from('PACK', 'ascii')]);
  const push = await postRaw('/o/r.git/git-receive-pack', pushBody);
  const adv2 = await get('/o/r.git/info/refs?service=git-receive-pack');
  const spliced = adv2.text.includes(OID_B) && !adv2.text.includes(OID_A);
  check('push splices cached advertisement', push.status === 200 && advCalls === 1 && spliced && counts.advGets === before + 1, `adv calls ${counts.advGets - before}, spliced=${spliced}`);
}
// 7. ls-refs after that push is spliced too, not re-fetched.
{
  const before = counts.uploadPosts;
  const ls = await postRaw('/o/r.git/git-upload-pack', lsBody);
  check('ls-refs spliced after push', counts.uploadPosts === before && ls.buf.toString('utf8').includes(OID_B), `calls ${counts.uploadPosts - before}`);
}
// 8. A push to a new branch invalidates the advertisement and ls-refs instead of splicing.
{
  const beforeAdv = counts.advGets;
  const beforeUp = counts.uploadPosts;
  const pushBody = Buffer.concat([pkt(`${'0'.repeat(40)} ${OID_C} refs/heads/feature\0report-status side-band-64k\n`), flush(), Buffer.from('PACK', 'ascii')]);
  await postRaw('/o/r.git/git-receive-pack', pushBody);
  const adv = await get('/o/r.git/info/refs?service=git-receive-pack');
  await postRaw('/o/r.git/git-upload-pack', lsBody);
  check('new-branch push invalidates git caches', counts.advGets === beforeAdv + 1 && counts.uploadPosts === beforeUp + 1 && adv.text.includes('refs/heads/feature'), `adv calls ${counts.advGets - beforeAdv}, upload calls ${counts.uploadPosts - beforeUp}`);
}
// 9. A fetch response cached before a push stays valid after it (immutable objects).
{
  const before = counts.uploadPosts;
  const again = await postRaw('/o/r.git/git-upload-pack', fetchBodyB);
  check('fetch cache survives push', counts.uploadPosts === before && again.status === 200, `calls ${counts.uploadPosts - before}`);
}
// 10. A refused (non-fast-forward) push leaves the cached advertisement alone.
{
  const before = counts.advGets;
  const pushBody = Buffer.concat([pkt(`${OID_A} ${OID_C} refs/heads/main\0report-status side-band-64k\n`), flush(), Buffer.from('PACK', 'ascii')]);
  const push = await postRaw('/o/r.git/git-receive-pack', pushBody);
  const adv = await get('/o/r.git/info/refs?service=git-receive-pack');
  check('refused push keeps advertisement', push.status === 200 && push.buf.toString('utf8').includes('non-fast-forward') && counts.advGets === before && adv.text.includes(OID_B), `adv calls ${counts.advGets - before}`);
}

console.log('[edge stats]', JSON.stringify(edge.stats()));
server.close();
loopback.close();
process.exit(failures === 0 ? 0 : 1);
