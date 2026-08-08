# The runner's registry

Status: **the pipeline runs end to end in a prototype, which is not in the tree.** `refresh()`
snapshots the catalog, resolves every active app's ladder, imports the release, and `findApp()`
serves it out of R2. Verified against `justfiles/app-draw` v0.4.1: 9,880,981 bytes extracted,
served with the digests `spec.json` pins. Everything below is therefore a design that has been
run, not one that ships — treat the names in it as the design's vocabulary rather than as
symbols you can go and read.

Serving is version-pinned: the shell resolves `current` once and every URL it emits hangs off
`/v/{version}/`, so assets, the reducer isolate and the spec all resolve by string construction
against a version nothing after the document has to look up, and carry a year's `immutable`.
That version is still caller-supplied, so it is gated on the release record — see
[The routes](#the-routes).

Not built yet: `store.json` and garbage collection. A merged catalog PR is the publication
approval; the importer publishes the release after validating and storing it.

Imports are capped per run (`IMPORT_BUDGET`), because an import spends roughly one subrequest
per bundle file against a 10,000 per-invocation cap. Skipped apps keep their previous ETags and
are resolved again next run, so a backlog drains on its own.

The shape that fell out is one module per phase, and it is worth keeping when this is rebuilt:
the `refresh()` orchestrator alongside the serving lookup, phase A (the catalog snapshot),
phase B (per-app release resolution), the importer, an authenticated GitHub client, and tag
normalisation. The phases themselves are specified in [Reconcile](#reconcile) below.

This is the private half of [`catalog.md`](./catalog.md) — its Phase 2, and the "Registry and
publication contract" step of [`hosted-apps.md`](./hosted-apps.md). The public catalog decides
*which apps exist*; this decides *what bytes we serve for them, and how they get there*.

## Decision

**R2 is the only store. There is no database.**

An app's entire footprint is one prefix. The public catalog is fetched per run and never
mirrored. The active-version pointer is a field in a per-app JSON document, and writing that
document is the publish operation.

```text
apps/{id}/info.json                  # everything we learned about the app
apps/{id}/{version}/spec.json        # the installed app spec: baseUrl, hash, files{}
apps/{id}/{version}/bundle.zip       # the archive we downloaded, for provenance
apps/{id}/{version}/files/…          # extracted bundle, served verbatim

catalog.json                         # snapshot of app-catalog at one commit; also the cursor
store.json                           # the served projection — public
```

## Goals

- Import a merged catalog entry into servable, integrity-pinned bytes with no human step
  beyond approving its catalog PR.
- Make publication atomic and rollback a pointer write.
- Keep every byte we ever served, so an installed device pinned to an old version keeps working.
- Spend the GitHub API budget on discovering releases, never on serving.
- Carry no state that the public catalog already carries.

## Non-goals

- No build service. We snapshot what the author published; we never compile it.
- No content-addressed deduplication across releases. See
  [Garbage collection](#garbage-collection) for why this is a safety property, not a shortcut.
- No mutable `current/` prefix, and no per-file copy on publish.
- No field-by-field mirror of the catalog. It is snapshotted whole in one read, never
  merged into per-app records — see [The snapshot](#the-snapshot-is-the-cursor).
- No second namespace. Hostnames are derived from ids — see
  [`catalog.md`](./catalog.md#the-id-is-the-hostname).
- **No renames, moves or aliases.** An app has one id for its lifetime in v1. See
  [Renames are deferred](#renames-are-deferred).

## Store only what the catalog cannot tell you

`catalog.md` already states the principle — *"Git is desired state, not the serving
database."* The test for whether a field belongs in R2 is whether one read of the catalog
could have produced it.

| Derivable from the catalog — **do not store** | Learned by importing — **must store** |
| --- | --- |
| `id` (the entry filename) | `repoNodeId` — GitHub's immutable numeric id |
| `repo` | every imported release: version, rung, ref, commit, digests, size |
| `status` | the active-version pointer |
| `asset` (the entry override) | `etag` / `checkedAt` — upstream poll state |

Everything on the left arrives in a single request that cannot tear. Caching it locally buys
nothing and creates a second thing that can be wrong. An earlier
draft of this design had a relational schema whose `app` and `alias` tables were ~80% the left
column; deleting them is what left an object store sufficient.

**This split is also the migration boundary.** Derived state can change shape for free — throw
it away and the next run rebuilds it from upstream. Learned state cannot: nothing can
reconstruct a digest we recorded a year ago. So the pressure to keep the right-hand column
short is not only about duplication, it is about how much data a future change has to migrate.

### The snapshot is the cursor

Desired state is never mirrored field by field, but it *is* snapshotted whole, into
`catalog.json`, at the commit it was read from. This is not the same mistake: a snapshot is
replaced wholesale and cannot drift per-field, whereas a per-app record merged from upstream
can.

It has to exist, because every later phase needs each app's `repo` on every run — and `repo` is
in the left-hand column above, so it is deliberately absent from `info.json`. Without the
snapshot, a cursor that skipped the catalog fetch would leave nothing to poll.

And once the entry set is persisted, it already carries the commit it came from, so it *is* the
cursor. There is no separate cursor object, and therefore no way for two objects to disagree
about which commit was last processed.

`Catalog.schema` is the mechanism that keeps this free to extend: bump it whenever the stored
shape changes — a field the parser starts reading, or one it stops writing — and a snapshot
written by an older parser is treated as absent and rebuilt from upstream. Changing the shape
is a parser edit and a constant, never a data migration.

## The documents

### `apps/{id}/info.json`

Everything we learned about one app. Small, and read on every page load, so release history
stays summarised here and the bulky per-file map lives in `spec.json`.

```jsonc
{
	"repoNodeId": "R_kgDOK1a2Bw",   // pinned at first import; a change is a hard stop
	"defaultBranch": "main",         // where rung 4 looks; learned with repoNodeId
	"current": "0.4.1",              // THE pointer — writing this document is publishing
	"etags": { "release": "W/\"a1b2…\"" },  // conditional upstream polls, by probe
	"checkedAt": 1754524800,
	"error": null,                   // last import failure; retried independent of the cursor
	"releases": {
		"0.4.1": {
			"rung": 1,                 // which step of the resolution ladder matched
			"ref": "v0.4.1",           // the tag, or the branch at rung 4
			"commit": "a3f9c21…",      // resolved separately — tags move
			"assetId": 503503988,      // rung 1 only; 2–4 take the repo zipball at `commit`
			"digest": "sha256-…",      // of the archive we downloaded
			"hash": "sha256-…",        // whole-app fingerprint, carried into the app spec
			"bytes": 9832104,
			"state": "ready",          // ready | yanked
			"at": 1754524800
		}
	}
}
```

`current` is `null` until the first import completes. `releases` is append-only in practice; a
version is frozen once `ready`.

**There is no `staging` state.** This document is written once every file has landed, so a
half-finished import leaves bytes in storage and no record here — which is exactly the orphan
[garbage collection](#the-rule) looks for. A state meaning "in progress" would have to be
written before the thing it describes exists, which is the ordering the next paragraph forbids.

**`etags` is a map, not a field**, because the ladder polls a different endpoint at each rung
and each carries its own ETag. It is keyed by probe (`release`, `head`) rather than by URL, so
it stays bounded. Rung 3 is absent from it deliberately — see [Phase B](#phase-b-releases).

This document does double duty as the **garbage-collection index**, which is why the write
ordering in [Import](#import) is load-bearing rather than incidental.

### `apps/{id}/{version}/spec.json`

The installed app spec of [`hosted-apps.md`](./hosted-apps.md) — the authored manifest enriched
with source and integrity metadata that the app itself cannot choose.

```jsonc
{
	"id": "justfiles.draw",
	"name": "Draw",
	"version": "0.4.1",
	"app": "app.js",
	"gui": "gui.js",
	"icon": "icon.png",
	"capabilities": { "volume": { "id": "volume", "scopes": [] } },

	// written by us, never by the author:
	"hash": "…",                    // fingerprints every path and digest, manifest and reducer included
	"files": { "gui.js": "sha256-…", "icon.png": "sha256-…" }
}
```

**`baseUrl` is absent from the stored document and injected when it is served.**
`AppManifest` treats a missing `baseUrl` as "the bundle IS the bytes", so this file is not
servable verbatim — which is the point. It is the only place an app id would appear inside
stored release data, and keeping it out is what makes a future rename a prefix move rather
than a rewrite of every spec we hold. See [Renames are deferred](#renames-are-deferred).

`hash` is computed exactly as `packages/app/appstore.ts`'s `appHash` does — paths sorted, each
`path\0hash` line joined by newlines, SHA-256, bare hex. A device compares that string to decide
whether an installed app is still the published one, so the two implementations have to agree
byte for byte.

`files` pins only the **mounted** half. `app.js` is absent from it deliberately: the reducer is
durable on the device, never mounted, so an installed app stays operable after the origin stops
serving that release. `hash` still covers it.

**It is named `spec.json`, not `manifest.json`, because the authored manifest is served beside
it** at `/v/{version}/manifest.json` (it is a bundle file). Two documents called `manifest.json`
meaning different things is the kind of thing that survives review and then costs an afternoon.

### `catalog.json`

The upstream catalog at one commit — the entry set, the commit it came from, and the ETag that
makes the next poll conditional. See [The snapshot is the cursor](#the-snapshot-is-the-cursor)
for why it exists and why there is no separate cursor object.

```jsonc
{
	"schema": 2,
	"sha": "a3f9c21…",
	"etag": "W/\"…\"",
	"entries": {
		"justfiles.draw": { "repo": "justfiles/app-draw", "status": "active" }
	}
}
```

**The id is the key and never a field**, mirroring the catalog's own rule that the filename is
the id. One copy cannot disagree with itself, and the container enforces uniqueness — of the id,
and so of the origin derived from it. Anything holding an entry reached it through its id.

Losing it costs one re-scan and nothing else. It is written by phase A.

### `store.json`

The served projection: for each active app, its live version, display metadata, capabilities,
`baseUrl` and per-file digests. Public, and the successor to
`apps/frieren/worker/appstore/feed.ts`'s output.

**It is neither a cache nor a scan result.** Most of what it contains — version, commit,
digests, `baseUrl` — does not exist in the upstream catalog at all; it is the output of the
whole import pipeline. The invariant that keeps it honest:

> **Rebuilding `store.json` must not require a GitHub fetch.** It is built by listing `apps/`
> and reading each `info.json`.

If rebuilding it ever needs the network, it has silently become a second mirror of upstream, and
the one snapshot we do keep is deliberately the only one. Holding the line means a corrupt or
stale projection is repaired by an admin route at zero rate-limit cost.

## Reconcile

### Two deltas, not one

The single most important structural fact: **the catalog cursor does not gate release
discovery.** Releases are discovered, never declared, so an app whose entry has not changed in
a year still needs polling. Collapsing the two deltas means no app ever receives a second
version.

```text
A. entry set — refreshCatalog()
   GET /repos/justfiles/app-catalog/commits/main  (If-None-Match on catalog.json.etag)
     304, or the same SHA → reuse the stored snapshot
     else → read apps/*.json at that SHA, diff, write catalog.json

B. releases — refreshApp(), every entry with status 'active', every run
   per app: poll upstream with info.json.etags[probe] (If-None-Match)
     304 → skip
     else → resolve the ladder to a version
            already in info.json.releases → compare the commit, skip
            else → check repoNodeId, hand back for import

C. rebuild store.json from apps/*/info.json
```

**An ETag records what we finished with, not what we saw.** While an import is outstanding,
`refreshApp` writes `info.json` with the *previous* `etags`, so the next run cannot 304 past
work it never did. That one rule is what lets phase B skip on a 304 without ever checking
whether the release behind that ETag was actually imported — the ETag's presence is the proof.

It also splits ownership cleanly: `refreshApp` is the only writer of `etags`, the import is the
only writer of `releases`. The cost is one non-304 poll after a successful import, because the
run that imports is not the run that advances the ETag.

### Why advancing the cursor in phase A is safe

The cursor moves before any import has run, which looks like it should lose work: a crash
between A and B would leave the catalog marked processed and the imports undone.

It does not, because **phase B iterates the snapshot, not the diff.** The next run reuses the
stored snapshot, still sees every active entry in it, and still polls each one. `touched` is an
optimisation for entry-level reconciliation, never the thing that drives imports — which is why
that reconciliation has to be written state-driven rather than event-driven.

Per-app import failure lives in `info.json.error`, so a single broken app is retried on the next
run regardless of what the cursor says, and never blocks the others.

### Phase A: the entry set

**Read the entry set in one request.** The requirement is that the set cannot tear: half the
entries from before a merge and half from after would look like apps appearing and vanishing.
One GraphQL tree read satisfies it — a single `apps` tree object and its blobs, resolved
together — and bills at roughly one point.

The alternatives all read the same bytes and cost more. A file at a time means N
`raw.githubusercontent.com` fetches, which **cannot be authenticated for a public repository**
and are limited to roughly 5,000/hour *per IP* — on an egress IP shared with every other Worker.
That is the same reasoning that makes us authenticate the API, applied to the one place it
cannot be. A tarball is one request but needs a tar reader that nothing else here would use,
since releases are ZIPs. Revisit once rung 1 forces a streaming ZIP reader to exist: the catalog
as a zipball would then be reuse rather than a second parser.

Authenticate every call even though the repository is public: unauthenticated access is 60
requests per hour *per IP*, and that IP is shared.

Two traps worth recording:

- **`object(expression: "<full-sha>:<path>")` returns null.** GitHub resolves a bare
  40-character SHA, and resolves `<short-sha>:<path>`, but not the two combined — verified
  against this repository. Use a ref expression (`refs/heads/main:apps`), which is the ordinary
  form.
- **GraphQL reports query failures as HTTP 200** with an `errors` array. A bare `res.ok` check
  passes straight through them.

Because the tree is read against a ref rather than the SHA, the recorded SHA comes from the
`commits/main` call that happens *first*. A merge landing in between therefore leaves the
recorded SHA **behind** the entries, never ahead: the next run sees a different ETag and
re-reads. The reverse ordering would silently skip a commit.

A read that fails part-way **fails the whole refresh** rather than writing a partial snapshot.
A missing app reads as a deletion, and deletion is the one thing this catalog is not allowed to
express.

Reconciling the entry set means creating `info.json` for a new entry and parking an app whose
entry stopped being `active`. Both are keyed off the snapshot rather than off `touched`, so a
run that skipped phase A still converges. Both therefore happen inside phase B's per-app pass,
which iterates that same snapshot — there is no separate entry-reconciliation step.

### Repository identity

A catalog entry points at `owner/name`, but a GitHub login is not permanent: rename or delete
the account and someone else can register it, at which point the same string resolves to a
stranger's repository. The string comparison still passes, so the numeric id is the only thing
that catches it. **A change is a hard stop requiring review**, not a flag.

**Check it before taking in bytes, not on every poll.** A hijacked `owner/name` cannot change
what we already serve; it can only try to become the next release, so the check belongs on that
path — immediately before a resolution is handed to the import, and at rung 4, which needs the
default branch out of the same response. Checking it every run would cost a request per app per
run for nothing: `/repos/{o}/{r}` carries the star count, so it almost never returns 304.

### Phase B: releases

The resolution ladder — rungs 1–4, asset selection, tag normalisation, bundle root discovery —
is specified in [`catalog.md`](./catalog.md#release-resolution) and is not repeated here.
What belongs here is how often we ask.

**Conditional requests are the whole optimisation.** Store an ETag per app and send
`If-None-Match` on `GET /repos/{o}/{r}/releases/latest`. A `304` **does not count against the
primary rate limit** when correctly authorized, and carries no body. Since most apps release
rarely, nearly every poll becomes free — 100 apps costs roughly `N_changed` points per run
instead of 100. Rung 4 (untagged, default-branch `HEAD`) uses the identical mechanism against
`GET /repos/{o}/{r}/commits/{branch}`.

**Rung 3 is the exception: its tag listing is read unconditionally.** GitHub makes no promise
about the order `/repos/{o}/{r}/tags` returns, so a `304` on the first page would not prove that
no newer tag had landed on a later one. An ETag there would buy a point per rung-3 app per run
and pay for it with a version that silently never arrives. The ladder is walked from the top
every run for the same reason — an app graduates a rung by pushing a tag, and nothing announces
it.

Two things deliberately **not** built yet, with the trigger for each:

- **Sharding the poll across ticks.** GitHub's *secondary* limit is ~900 points/minute for
  REST, so conditional requests being free against the primary limit does not make them free to
  fire all at once. Bucket by `hash(id) % N` and poll one bucket per tick when app count
  approaches that. Under 100 apps, poll everything every run.
- **GraphQL batching.** One query can ask 100 repos for their latest release at a cost of ~1–2
  points. But GraphQL has no conditional-request support, so it is a *fixed* cost regardless of
  change rate — at 100 apps it is roughly a wash with ETags and materially more code. Reach for
  it an order of magnitude later, if ever.

The real endgame is neither: because we supply `justfiles/release` as a reusable workflow, it
can `POST /admin/imported?app=…` after cutting a release, and polling drops to a daily safety
net. That is the "ping, not payload" shape of `catalog.md` applied one level further out.
Do not over-invest in poll optimisation before it lands.

### Import

Treat every archive as hostile. The size, count and secret-scanning limits are specified in
[`catalog.md`](./catalog.md#security-boundary) — ~50 MB extracted, ~500 files, ~20 MB per
file, `app.js` capped separately at ~1 MB, and a hard fail on `.env*`, `*.pem`, `id_rsa*`,
`.npmrc`, `*.key`.

Two implementation facts that shape the code:

- **`DecompressionStream` cannot read ZIP** — it is a container format. Parse the central
  directory, then hand each entry's payload to `DecompressionStream('deflate-raw')` so the
  inflate itself stays native.
- **Never trust a declared length.** Every size a ZIP carries is written by whoever built it,
  so the cap is a running count of bytes actually produced, and cancelling the reader stops the
  inflate through backpressure. Trusting the header is precisely the decompression-bomb hole.

`@justfiles/app`'s `bundleFromZip` exists and is deliberately not reused: it calls fflate's
`unzipSync`, which inflates every entry into memory at once. That is right for a devkit draft
and is the bomb hole for a stranger's release.

**The archive is buffered whole**, because a ZIP is indexed from its tail — there is no
forward-only parse. That makes the compressed cap (~20 MB) a *memory* bound rather than a
policy one, and it is the only reason a compressed size is capped at all. Streaming it into R2
by multipart and range-reading it back would drop peak memory, at the cost of roughly doubling
the subrequests per import; worth revisiting only if a real bundle approaches the cap.

**The secret scan applies under the bundle root only.** The hazard the rule exists for is
rehosting a secret at a public URL, and only files under the root are rehosted — while
`.env.example` beside a repository's source is ubiquitous, so hard-failing on the whole archive
would reject the repository-tree rungs almost everywhere.

**Write order is load-bearing:**

```text
1. files/…        every extracted entry, streamed straight into its object
2. spec.json      once every file succeeded
3. info.json      the release recorded; `current` flips to it
```

Nothing is reachable until step 3 — the serving path enforces it, refusing any version the
record does not name — and a crash before it leaves an orphan that
[garbage collection](#garbage-collection) is designed to find. Reversing steps 2 and 3 would
make `info.json` claim a release whose spec does not exist.

**A version is frozen once written.** A re-import resolving the same version to a different
commit is a flag, never an overwrite — Go's checksum database exists to catch exactly this, and
keying bytes by version makes it structural rather than a check someone has to remember.

### Publish and rollback

Publishing is one object write: set `current` in `info.json`. Rollback is the same write with
an older version. Because `info.json` is a single R2 object and R2 writes are strongly
consistent and atomic per object, a reader sees the old pointer or the new one, never a torn
one. There is no transaction to want.

The catalog PR is the first-publication approval. Once the import validates and stores the
release, its final `info.json` write publishes it; there is no second approval gate.

## Serving

### The routes

| Route | Resolves to | Lookup |
| --- | --- | --- |
| `/` | the shell document | `info.json.current`, then that release's `spec.json` |
| `/v/{version}/{path}` | `apps/{id}/{version}/files/{path}` | `info.json.releases[version]`, then string construction |
| `/v/{version}/spec.json` | that release's app spec, `baseUrl` injected | the same, then the spec |
| `/v/{version}/worker.js` | `sandboxWorkerSource('/v/{version}/app.js', 'web')` | the same; the body is generated |

**The shell emits version-pinned URLs**, and nothing else resolves the live version. That is
what makes resolving `current` a per-*page-load* cost rather than a per-asset one, and it means
everything under `/v/…` is immutable and carries `Cache-Control: public,
max-age=31536000, immutable`.

**The version in the path is caller-supplied, so it is checked against the release record.**
Nothing under `/v/…` is served unless `info.json` names that version `ready` — the gate that
makes "nothing is reachable until step 3" of the [write order](#import) true of the serving
path and not just of the importer. Without it a guessed version could be answered out of a
half-written import and cached for a year as immutable, over bytes the retry then rewrites; a
yanked release would also stay reachable for ever. It costs one `info.json` GET on a cache
miss, behind the same cache as the shell's, and it buys back the invariant the year-long
`immutable` is only safe under.

The document costs two reads rather than one, because `info.json` deliberately carries no
display metadata: a second copy of an app's name is a second thing that can disagree, and both
reads sit behind the same cache.

### The version in the path is not about installing old versions

Nobody can install one — discovery only ever offers `info.json.current`. The version is there
so that an **already-installed** device keeps working. It holds `files` digests over the exact
bytes of the release it installed, and `kernel.app.ts`'s `mount()` verifies them on every cache
miss:

```text
cache miss → fetch baseUrl/gui.js → verify(actual vs pinned) → throw 'hash mismatch'
```

With an unversioned `baseUrl`, the next publish turns every subsequent cache miss into that
throw — a dead app, not a stale render, and one it cannot self-heal from because it does not
yet know a newer spec exists. Worse for an unpinned file, which `mount()` accepts on presence
alone: one version's GUI against another version's reducer.

So "we do not want to host old versions" is a *retention* question — how many, for how long,
answered by [garbage collection](#garbage-collection) — never a URL-shape one.

### `baseUrl` is injected from the request's own host

```ts
baseUrl: `${new URL(c.req.url).origin}/v/${version}/`
```

Derived from the host the request arrived on, not from the id. A custom domain therefore pins
itself with nothing to guess, and the id never enters stored release data — which is what keeps
a future rename a prefix move. Storing it would mean rewriting every `spec.json` we hold on any
domain change.

**The author must never supply it.** `baseUrl` tells a device where to fetch executable bytes;
an author-supplied one would point at a host we do not control, leaving us publishing bytes we
never reviewed, integrity pins checked against a server that can rotate them, and no way to take
anything down. `AppManifest` already states the rule — *"written by the installer from the
catalog entry, never declared by the app itself"* — so an author's `baseUrl` is overwritten,
not honoured.

Put the Cache API in front of the `info.json` read and the remaining round trip disappears in
practice — the first request in a colo pays it, the rest do not. A stale shell for the length of
that TTL serves an entirely coherent *old* version, never a mixture of two, which is a property
a mutable prefix could not offer.

### The invariant that the folder layout requires

Under the previous `bin/{id}/` layout, `asset()` was safe by construction: the directory held
only bundle files. Grouping everything about an app under `apps/{id}/` changes that —
`info.json` now sits in the same prefix and carries `etag` and the full release history.

> **`asset()` resolves into `apps/{id}/{version}/files/` and nowhere else.**

```ts
const asset = (path: string) => `apps/${id}/${version}/files/${path.replace(/^\//, '')}`
```

Because `version` sits between the app and the request path, no path can climb out to
`info.json` or `spec.json`. It is the same "exact key, cannot escape the prefix" property the
current glob has, one level deeper — but it is no longer obvious from the shape of the code, so
it belongs in a comment where `asset` is defined.

## Garbage collection

Not needed at launch — keeping every version of 100 apps is a rounding error — but the *shape*
has to be decided now, because it constrains the storage layout.

### Keep every version

This is not a trade-off. Devices pin `baseUrl` to a version path and hold per-file digests, so
overwriting a version in place produces a digest mismatch on the next cache miss — a hard app
failure, not a stale render. Rollback needs the previous bytes. And `catalog.md` requires
proof of the exact bytes previously served.

The cost argument is unambiguous: R2 standard storage is $0.015/GB-month, and `app-draw` is
~9.4 MB. A thousand apps holding ten versions each is 100 GB — **$1.50/month**.

### The pitfall this design exists to avoid

Every well-known registry GC bug is the same bug — shared-blob reference counting:

- [distribution#3045](https://github.com/distribution/distribution/issues/3045) — GC concurrent
  with a push corrupts the pushed image; the documented mitigation is read-only mode.
- [distribution#4461](https://github.com/distribution/distribution/issues/4461) — GC removed all
  blobs and corrupted the registry.
- [harbor#23199](https://github.com/goharbor/harbor/issues/23199) — Harbor replaced
  storage-driven GC with a DB-driven one to avoid read-only mode, and created **storage-only
  orphans**: blobs that reached storage without an index record, permanently invisible to GC.

**We have no refcounting problem, and that is the reason not to deduplicate.** Because bytes are
keyed by `apps/{id}/{version}/files/…` and never shared between releases, no object is ever
referenced twice, and deleting a version is an unconditional prefix delete. Content-addressed
storage would save pennies and buy back the entire bug class.

### The rule

**Storage-listed, index-checked, with a grace period.** Harbor's mistake was trusting the index
to enumerate what exists; do it the other way round:

1. `list({ prefix: 'apps/{id}/', delimiter: '/' })` — every version prefix that exists.
2. Delete any prefix `info.json.releases` does not claim. This is what catches the
   crashed-mid-import orphan, which an index-driven sweep cannot see.
3. **Never reap a prefix younger than 24 hours**, so an in-flight import is not deleted under
   itself — the fix for distribution#3045 without needing read-only mode.
4. Never touch `current`, or any version newer than it.

Run it as a separate pass. Never in the import path.

## Why no database

D1 was the obvious answer and it is the wrong one at this size. What it would have bought, and
what replaces it:

| D1 buys | Without it |
| --- | --- |
| Transactions | Not needed. The only invariant is write *ordering*, and each step is a single atomic object write. |
| Queries — "what failed?" | Emit an admin projection beside `store.json`. One line in the rebuild. |
| Time Travel | Releases are immutable and append-only; entry state is in the catalog's git history. Corruption means a bad pointer, fixed by writing the pointer. |
| Ops access | `wrangler r2 object get/put` instead of `wrangler d1 execute`. |

Reading all 100 `info.json` objects per run is one `list()` plus ~100 Class B GETs — about
**$0.03/month** at hourly.

**The trigger to revisit is not app count.** It is needing a query an object store cannot answer
cheaply: a store front-end with sorting and pagination, or abuse forensics like *"which releases
reference commit X"*. Neither is close. Two things keep that migration cheap when it comes:
`info.json`'s field shape is already the schema, so it is a mechanical backfill; and the request
path never reads the state store for assets, so the choice stays swappable rather than
load-bearing.

## Why no symlink, and why not a mutable `current/`

**R2 has no alias primitive.** Its [S3 compatibility
table](https://developers.cloudflare.com/r2/api/s3/api/) lists `x-amz-website-redirect-location`
as unsupported on both `PutObject` and `CreateMultipartUpload`, `PutBucketWebsite` /
`GetBucketWebsite` are unimplemented, and there is no symlink or object tagging.

The workaround — copying the bundle to `apps/{id}/current/files/…` on publish — is the one
`catalog.md` already forbids, because a failed copy exposes files from two releases at once.
It also reintroduces the atomicity problem that the single-object pointer deletes: R2 cannot
swap N objects atomically, but it can replace one.

So the pointer read stays, and it is cheap for the reasons in [Serving](#serving): one GET per
page load, cacheable, and paid for by immutable asset URLs.

## Renames are deferred

`catalog.md` designs renames in full — `formerIds`, two-way tombstone links, collapsed
chains, an alias map the device applies during reconcile. **None of it is v1 here.** An app has
one id for its lifetime; `to` and `formerIds` are not read, and an entry carrying them parks on
the `status` rule rather than being followed.

This is not a cost decision. It is that a rename is the highest-risk operation in the system —
it is precisely how an established app's install base would be hijacked — and its hardest
consequence is still an open question in `catalog.md`: because the hostname is derived from
the id, a rename **moves the origin**, and no server-side mapping reaches an anonymous visitor's
IndexedDB. Shipping renames before that is answered would make every rename a silent data-loss
event. Shipping them after costs nothing extra, because of what follows.

### Why adding them later needs no migration

Three properties, none of which need defending today, are what make this safe to defer:

- **The catalog snapshot is derived.** `formerIds` is on the left-hand side of
  [the table above](#store-only-what-the-catalog-cannot-tell-you) — it exists upstream, is
  dropped by the parser, and reappears the moment the parser reads it. `Catalog.schema` forces
  the rebuild that picks it up, so the change is a parser edit and a constant.
- **`info.json` never names another app.** Learned state is the half that genuinely cannot be
  reconstructed, so it is the half a migration would have to touch — and nothing in it is keyed
  by, or refers to, an id other than its own. A rename becomes a prefix move, not a rewrite.
- **The id appears in served bytes exactly once.** `spec.json` carries `baseUrl`, which contains
  the derived hostname. That is the only place a rename would force a rewrite of stored release
  data, and it can be avoided outright by injecting `baseUrl` at serve time rather than storing
  it — worth doing when `spec.json` is implemented, and cheap only if decided then.

The third is the one that has to be honoured now, because it is a choice about what gets
written. The first two hold by construction.

## Prior art

| System | Shared problem | What we take |
| --- | --- | --- |
| [Go module proxy](https://go.dev/ref/mod) | Mirrors upstream VCS into immutable snapshots; upstream can vanish or move tags | A deleted upstream still resolves from cache forever — the strongest argument for keeping every version. `@latest` is a cheap endpoint separate from content, which is `info.json` vs `files/`. Its checksum database exists to detect a moved tag. |
| [OCI distribution](https://github.com/opencontainers/distribution-spec) | Mutable tag → immutable content | A tag is a pointer *record*, never a copy. Notably the spec is silent on tag mutability and GC, which is exactly where every implementation's bugs are. |
| [Netlify / Vercel](https://www.netlify.com/blog/2021/02/23/terminology-explained-atomic-and-immutable-deploys/) | Atomic publish, instant rollback | The deploy is immutable; going live is an alias flip, and rollback is flipping back. That is `info.json.current`. |
| [unpkg](https://unpkg.com/) | Resolve "latest", then serve a file | Unresolved URLs 302 to fully-versioned ones so the pinned URL caches permanently. We go one better by emitting pinned URLs in the shell, avoiding the hop. |

## Limits and cost

Everything below is Workers **Paid**; the Free plan allows 10 ms of CPU on a cron trigger,
which is not enough to read the catalog, let alone import a release.

| Limit | Value | Consequence |
| --- | --- | --- |
| Cron CPU, interval ≥ 1 hour | 15 min | An hourly cron gets 30× the CPU of a 5-minute one |
| Cron CPU, interval < 1 hour | 30 s | Sub-hourly schedules cannot import inline |
| Scheduled handler wall clock | 15 min | Hard ceiling on a single run |
| Isolate memory | 128 MB | Why extraction streams per entry |
| Subrequests per invocation | 10,000 | Not binding at this size |
| GitHub REST secondary limit | ~900 points/min | Binds before the 5,000/hour primary limit does |

| Cost at 100 apps, hourly | |
| --- | --- |
| Cron invocations (720/month) | within included requests — **$0** |
| Reading `info.json` × 100 × 720 | 72k Class B — **$0.03/month** |
| R2 storage, 100 apps × 10 versions × 10 MB | 10 GB — **$0.15/month** |
| R2 Class A writes | ~$0.45/year at a thousand apps |

**The money is not the constraint. The 15-minute wall clock and the GitHub rate limit are.**

### Cron detects; import may need to move

At this size the cron can import inline. It will not stay that way: fifty apps releasing at once,
each a ~10 MB download and re-upload, exceeds 15 minutes. Structure `refresh()` to return the
apps needing import and keep `importApp(id)` separate, so the split is a one-line change to a
Queue consumer — one binding, 15-minute wall clock of its own, 100 retries, automatic backoff.

Not Workflows: they would give durable per-step resumption at the cost of a class, a step model
and instance lifecycle, plus per-step billing. A Queue is the smaller thing for the same benefit.

Two operational notes. **Cron triggers are best-effort** and can be delayed or skipped; the
cursor-based reconcile is naturally resilient because it catches up from a SHA rather than
processing "this hour". And **overlapping runs are harmless** given the freeze-on-write rule
above, so no lock is needed — though R2 supports conditional writes (`onlyIf: { etagMatches }`)
if that ever stops being true.

## Decisions taken

1. **R2 only; no D1, no KV.** The relational schema that started this design was substantially a
   mirror of the catalog. Removing it left nothing an object store could not hold.
2. **One prefix per app**, `apps/{id}/…`, so an app's whole footprint — state, every release,
   every byte — is one `list()` for GC, takedown and inspection.
3. **The version is the release id.** It is already what `baseUrl` encodes, so there is no second
   identifier to allocate, and freezing `apps/{id}/{version}/` becomes structural.
4. **Keep every version.** Devices pin version paths; overwriting breaks installs. $1.50/month at
   a thousand apps.
5. **No content-addressed deduplication.** Pennies saved, and it would buy back the reference
   counting bug class that every registry GC failure lives in.
6. **`store.json` is a derived projection, not a cache** — rebuildable from `apps/*/info.json`
   with no network access. `catalog.json` is the one snapshot of upstream, and it is also the
   cursor, so no second object can disagree about which commit was processed.
7. **The cursor gates the entry set only.** Release discovery runs every time, gated per app by
   an ETag.
8. **`spec.json`, not a second `manifest.json`**, because the authored manifest is served beside
   it.
9. **`asset()` resolves only into `apps/{id}/{version}/files/`** — the invariant that keeps
   grouping state and content under one prefix safe.
10. **No renames in v1**, deferred on the extensibility argument below rather than on cost.

## Open decisions

1. **Retention.** Keeping everything is right at launch and wrong eventually. The GC rule above
   is designed; the *policy* — how many versions, how old, whether a yanked release is deleted or
   only unlinked — is not.
2. **What a rename does to a live hosted app's anonymous data.** Inherited from
   `catalog.md`; the origin moves with the id and no server-side mapping reaches an anonymous
   visitor's IndexedDB. Not v1 — see [Renames are deferred](#renames-are-deferred) — but it is
   the question that has to be answered before renames can be, and it is a product decision
   rather than a storage one.
3. **Whether `store.json` stays one document.** It carries per-file digests for every app, so
   it grows with both app count and bundle size. A per-app fetch or a paginated index is the
   successor; nothing forces it yet.
4. **Cache invalidation on publish.** A short TTL on the `info.json` read is correct and simple,
   but means a publish takes up to that long to be visible. Whether that is acceptable, or worth
   a Cache Purge API call, is untested.
