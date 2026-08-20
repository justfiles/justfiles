# T13 — HTTP wire: `storeApi` + `httpStore`

**Status:** done
**Phase:** C — backends and wire
**Depends on:** [T1](t01-store-types-and-memstore.md), [T2](t02-change-feed-and-lineage.md), [T3](t03-blobs.md); [T10](t10-authority-and-conflicts.md) for the server-side wrapper
**Context:** [overview](README.md) · [design #3, "the same seam is the storage API and the wire"](../../kb/fs/fable-design.md)

## Goal

A remote peer is just another `Store`. The seam IS the wire — this task is
where that claim gets proven.

## Context

- Server pattern: `packages/core/src/fs.ts` (Hono + zod, bigint-as-string
  encoding, blob hash verification on PUT). Reuse those helpers' IDEAS, not
  their routes.
- The client lives in `packages/fs` — fetch only, zero dependencies.
- Wire shape: `Node` rows verbatim; bigints as decimal strings. Nothing is
  stripped before sending, because no per-replica state lives in the row.

## Files

- `packages/core/src/store.api.ts` — Hono routes over an injected `Store`
- `packages/fs/store.http.ts` — `httpStore(baseUrl, headers?)`
- conformance test wiring the two in-process

## RED

- Routes: `GET /node/:id`, `GET /child?parent&name`, `GET /children`,
  `GET /since`, `POST /commit` (rows + guards; a guard failure is a 409
  carrying which guard failed), `GET|HEAD|PUT /blob/:hash` (PUT verifies the
  hash — 400 on mismatch).
- **Conformance over the wire:** run the FULL suite against `httpStore` whose
  fetch is the Hono app's `app.fetch` over `store.sqlite` or memStore. The
  suite passing unchanged over HTTP is the design's central claim — one
  contract, no capability negotiation.
- A foreign-lineage cursor over HTTP maps to the same typed error as
  [T2](t02-change-feed-and-lineage.md).
- The server wraps its store in `authority()`: an invariant-breaking commit
  gets a 409, and the engine replan from
  [T10](t10-authority-and-conflicts.md) works over this wire end to end — one
  integration test, two `httpStore` clients against one hub.

## GREEN

Implement both sides.

## Done when

Conformance + the end-to-end replan test green.

**Done:** both, in `packages/core/src/store.api.test.ts`. The suite runs
unchanged over `httpStore`, whose fetch is the mounted Hono app's — no
capability negotiation appears anywhere, because there is nothing to negotiate.

Two notes for the tasks after this one:

- The routes verify nothing themselves. Rule 7's hash check and rule 9's
  invariants live in the store the API is handed, so a host serves
  `storeApi(authority(store))` and the wire only turns a refusal into a status.
  That is what lets the same suite — which lies about hashes on purpose — run
  over the wire against a raw store.
- The wire format lives in `packages/fs/store.http.ts`, both directions, and the
  server imports `encodeNode`/`decodeCommit` from it. Two copies of a codec drift.

**No other route exists on this API.** An addition needs a design review that
starts with "why can this not be rows?"
