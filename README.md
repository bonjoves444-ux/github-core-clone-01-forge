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
