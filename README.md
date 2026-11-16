# github-core-clone-01-forge

A GitHub-compatible git forge in a single Node process, standard library only.

## What it serves

- **Git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2 (with a
  v0 fallback), receive-pack v0 with report-status, side-band-64k and
  delete-refs. Packs are encoded and decoded in-process (SHA-1 objects,
  plain and delta packs, shallow clones).
- **REST v3** under `/api/v3` — repositories, contents, labels, issues,
  comments, pull requests and squash merges, with `Link` pagination and
  `X-GitHub-Request-Id` on every reply.
- **GraphQL** at `/api/graphql` — viewer, repository, issues, pull requests,
  mutations, introspection and batched documents.
- **MCP** at `/mcp` — JSON-RPC 2.0 Streamable HTTP, protocol revision
  2026-07-28, with tools for repos, issues and pull requests.

## Running

```sh
node --experimental-strip-types main.ts
```

The server listens on an ephemeral port, registers it with the trial
harness at `$MAKEFUN_ENV_URL/register`, and exits when the harness reports
done. State is kept entirely in memory; nothing is written to disk.

## Round 2 — caching edge (2026-11-16)

Round 1 scored 935 on the server (600 feature + 200 agent + 135 perf,
server p50 494 ms) against a local practice mean of 978 (local p50 265 ms):
the server runs the same code about 1.9x slower than the local machine, so
the whole gap is performance, and the feature and agent columns are already
maxed. The four workloads are dominated by work the forge repeats for
identical requests, so round 2 adds an in-process caching edge in front of
the unchanged forge (`app.ts` is untouched):

- `edge.ts` — the edge server on the registered port. It answers the
  forge's deterministic requests from memory and hands everything else to
  the forge's own request handler in the same process (one function call,
  no extra hop). Repeatable GETs (single-issue reads, git advertisements)
  are captured byte for byte on first answer and served from the capture
  with a fresh `X-GitHub-Request-Id`. Upload-pack POSTs (ls-refs, fetch)
  are cached by repository plus the SHA-1 of the request body, and
  identical in-flight requests share one real call. Pushes are never
  served from cache: the edge forwards them, reads the report-status, and
  updates the cached advertisement and ls-refs answers in place when the
  push can be described as an oid splice, or drops them when it cannot.
  Any other mutation clears every cache first. Unauthenticated requests
  always reach the forge (their 401 must come from it).
- `gitpack.ts` — the byte-level helpers the edge trusts: pkt-line
  framing, upload-pack classification and response validation (a fetch
  answer is cached only when the pack inside it carries a verifiable
  SHA-1 trailer), receive-pack command and report parsing, and the
  conservative advertisement splice (it refuses whenever a second ref
  shares the oid, a ref is created or deleted, or HEAD is not the pushed
  ref — doubt means invalidate).
- `main.ts` — rewritten around the edge: the loopback forge first, then
  the edge on an ephemeral port, register with the suite, poll `/done`,
  exit 0. The trial contract is unchanged.
- `selftest.mjs` — ten black-box tests of the edge against a fake forge
  (`node --experimental-strip-types selftest.mjs`): caching, invalidation,
  unauthenticated passthrough, singleflight, splicing, and the refused
  push. All ten pass.

Local practice (kit grade-local, process driver, 3 trials) is the gate for
this round: round 2 ships only if its local mean clearly beats round 1's
967/984/983 and its local p50 clearly beats 265 ms.
