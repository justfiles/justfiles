# Frieren app store (future)

> Status: **deferred — blocks nothing in local-first.** Install/uninstall already
> works as plain file I/O on the volume (`LOCAL_FIRST_PLAN.md` Phases 4c/4f). This
> doc describes the *future discovery layer* on top of that — browse, categories,
> install-from-catalog, updates — and the trust work required before public
> third-party apps.

## Foundation: apps are just files

Local-first settled the storage model: an app is a directory of files in the
user's volume.

```txt
/applications/<id>/   app.js, gui.js, manifest, icon, assets
/state/<id>.json      app state
/data/<id>/...        app user data
```

Installing = writing files into `/applications/<id>/`. Uninstalling = deleting
them. Both kernels load an app by reading those files; nothing else is involved.

Size and distribution are handled **below** the file abstraction by the volume's
own blob layer — content-addressed blobs (`InodeMeta.contentHash`), lazy
hydration (`synced({ lazyContent })`), R2 on the server, IDB in the browser.
There is **no** separate app-asset cache, install record, or package resolver;
that was an earlier design that duplicated the volume's blob layer one level too
high.

So the app store adds **nothing structural to install/uninstall.** It is purely a
way to *discover* apps and *get their files into your volume* from a shared
catalog instead of from a local zip.

## What the store adds (future)

1. **Catalog** — a browsable list of apps. Extends the built-in `catalog.json`
   (Phase 4c) with `category`/`description` and third-party entries.
2. **Install from catalog** — download the app's files into `/applications/<id>/`.
   On a synced profile they replicate to the user's R2 like any file and sync down
   to other devices (lazy, hydrate on launch). Offline, a synced app whose bytes
   haven't hydrated on this device yet shows a "needs network once on this device"
   launch state — the general lazy-file property, not an app-store special case.
3. **Updates** — track the installed version per app; when the catalog advertises
   a newer one, offer to refresh the files. This reuses the same
   compare-version-and-rewrite logic as the built-in boot reconcile (Phase 4c).
4. **Publishing** — let an author upload an app's files so others can install
   them. The store keeps canonical bytes in R2; install copies them into the user
   volume. (A local zip install is the offline, single-user version of this — it
   writes files directly, with no catalog.)

## URL scheme (already fixed by Phase 4c)

The store reuses the namespace Phase 4c established for built-ins, so no route
changes when it ships:

```txt
GET /appstore/catalog.json                  catalog (built-ins now; + third-party + category/description later)
GET /appstore/apps/<id>/<version>/<path>    an app file (app.js, gui.js, manifest.json, icon)
```

Built-ins serve these straight from the static `ASSETS` binding (public,
SW-precached, no Worker). Third-party apps occupy the **same** routes but resolve
through the Worker from R2 — add `/appstore/*` (or just the dynamic paths) to
`run_worker_first` in `wrangler.jsonc` when that lands. Per-file `hash` in the
catalog is for integrity on install and dedup; version-pathed byte URLs are
immutable and permanently cacheable.

## Asset storage

The store keeps canonical app bytes in R2, content-addressed by hash, so one blob
is shared across every user who installs the app. Install streams those bytes into
the user's volume, where the volume's own blob layer dedups/hydrates them per the
local-first model. The publishing/upload pipeline and signing are TBD when this is
built.

## Trust (blocks public third-party apps)

A Web Worker is **not** a security sandbox (same origin, can `fetch`), and catalog
bytes are unsigned. Public untrusted apps require **both**:

- `LOCAL_FIRST_PLAN.md` Phase 5 — cross-origin isolation of app execution/GUI;
- a review/signing/trust policy for catalog entries and their bytes.

Until both land, limit installs to built-ins, reviewed/trusted apps, and
self-installed local zips.
