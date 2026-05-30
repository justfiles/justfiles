# Frieren app packages / app store

A self-contained feature: apps are **content-addressed packages**, not copied
bytes in the user volume. The user volume stores small *install records*; the
immutable app bytes live in the app store (Assets/R2) and are cached locally by
hash. Both the browser kernel and the server kernel resolve and run apps through
the same package resolver.

This feature stands alone. `LOCAL_FIRST_PLAN.md` Phase 4 **depends on** it
(built-ins must be installable without a server-side install, and offline launch
needs a local asset cache), but this feature does not depend on local-first —
it is an improvement to how apps are stored and distributed and could ship on the
current architecture.

> No backward-compatibility constraint: neither kernel path has shipped a
> volume-copied-bytes app to real users, so the resolver swaps to install records
> outright — no dual-read, no migration. Get the model right.

---

## Model

The volume stores *what is installed*; the app store stores *the bytes*.

```txt
User profile volume:
  /applications/<id>/install.json   package lock/install record
  /state/<id>.json                  app state
  /data/<id>/...                    app user data

App store / R2 / Assets:
  packages/<id>/<version>/manifest.json
  blobs/sha256/<hash>
```

`install.json` pins immutable bytes by hash. URLs are locations, not authority:

```json
{
  "schema": "frieren/app-install/v1",
  "id": "app-paint",
  "version": "1.0.0",
  "source": "system",
  "manifest": { "id": "app-paint", "name": "Paint", "app": "app.js", "gui": "gui.js" },
  "files": {
    "app.js": { "sha256": "...", "url": "/api/app-assets/sha256/..." },
    "gui.js": { "sha256": "...", "url": "/api/app-assets/sha256/..." }
  }
}
```

`source` is `system` (OS-provided, from the catalog), `store` (app-store
install), or `local` (self-installed zip). The install record is synced like any
other volume file; it is therefore only as trustworthy as whoever wrote it (see
*Trust* below).

## Resolver

Both kernels resolve an app through the same steps:

1. read `/applications/<id>/install.json` (or, for a built-in with no record yet,
   a system-catalog default record);
2. load the requested file by `sha256` from the **local asset cache**;
3. if missing and online, fetch via `/api/app-assets/sha256/<hash>`, verify the
   hash, then cache;
4. run from cached bytes.

### Pluggable asset backend (one resolver, two caches)

The resolver logic is shared, but the *asset cache* it reads/writes is injected,
because the two kernels live in different runtimes:

- **Browser kernel** → a content-addressed **Cache Storage API** cache (see
  below). On a cold/offline miss it cannot fetch; the launch reports
  "needs network once on this device."
- **Server kernel (Durable Object)** → reads blobs directly from the **R2
  binding** (or Assets). It is always "online" relative to R2, so step 3 is a
  direct R2 `get` by hash; no browser cache involved.

So the resolver is `resolve(installRecord, file, assetStore)` where `assetStore`
is `{ get(hash), put(hash, bytes) }`. Scope-resolution and hash-verification are
shared; only the byte store differs. This keeps the "same hash-pinned bytes in
both kernels" guarantee without pretending both have the same storage.

## Local asset cache (browser)

- Backed by the **Cache Storage API** (`caches.open('frieren-app-assets')`),
  keyed by a synthetic request URL of the hash (e.g.
  `/__asset/sha256/<hash>`). Content-addressed: immutable, so entries never go
  stale and can be served with permanent cache semantics.
- **Shared across all local profiles on the browser** — content is identified by
  hash, not by user, so built-in bytes are stored once and dedup across profiles
  for free. The per-profile IDB volume holds only install records, not bytes.
- **Eviction**: LRU/size-bounded sweep keyed by hash; never evict a hash still
  referenced by an installed record of any profile. Re-fetch on miss when online.

## Endpoints

```txt
GET /api/app-store/catalog            system + featured catalog (ids, versions, hashes, urls)
GET /api/app-store/packages/:id/:version   package manifest
GET /api/app-assets/sha256/:hash      immutable blob (Worker streams R2, or redirects to a signed/direct R2 url)
```

`/api/app-assets/sha256/:hash` is immutable and public-cacheable; it is the one
endpoint on the offline/SW hot path.

## Built-in distribution

Do **not** import generated `@justfiles/app-*/bundle` byte modules into the
Worker/client as the production distribution mechanism — that grows the JS
bundle. Instead, at build/deploy time:

- copy built-in app build output to static Assets/R2;
- generate a tiny **system app catalog** (id, version, manifest, file hashes,
  urls) from the deployed assets.

**Deploy ordering is atomic-by-construction:** assets are content-addressed by
hash, so upload blobs to R2/Assets **first**, then publish the catalog that
references them. A catalog is never live before its blobs exist; an old catalog
keeps pointing at still-present (immutable) blobs. Never delete a blob a live
catalog references.

### Materializing & reconciling built-ins

- On boot, **reconcile the catalog against the profile's install records on every
  boot** (not just first boot): materialize install records for system apps the
  profile lacks, and pick up version bumps.
- Reconciliation **honors disabled markers**. "Uninstalling" a system app writes
  `/system/apps/disabled/<id>.json`; the OS hides it without deleting
  OS-provided package bytes, and a catalog version bump must **not** resurrect a
  disabled app.
- Uninstalling a *user* app (`source: store`/`local`) removes its install
  record, state, and data outright.

## Local zip install (offline-capable)

Fully local, no backend:

- unpack the zip, hash each file, write the bytes into the local asset cache;
- write an install record with `source: "local"`;
- it runs on this browser immediately.

Publishing/uploading a local package so other devices can install it is a later
app-store feature.

## Installed ≠ launchable offline (on this device)

An install record syncs across devices, but the referenced blobs do not live in
the volume — they live in the per-device asset cache. So a record can sync down
to a second device whose cache is cold; offline, that app **cannot launch until
it has been fetched once on that device**. Built-ins dodge this via boot
hydration (`LOCAL_FIRST_PLAN.md` Phase 3); a synced *user-installed* app does
not. Surface this as a clear "needs network once on this device" launch state,
not an error.

## Trust (open, blocks public third-party apps)

The package/R2 asset model supports third-party apps, but the install record is
just a synced file and package bytes are unsigned. Public untrusted apps require
`LOCAL_FIRST_PLAN.md` Phase 5 (cross-origin isolation) **and** a
review/signing/trust policy for the catalog and package manifests. Until then,
limit the store to built-ins, reviewed apps, and self-installed local zips.
