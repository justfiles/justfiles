---
project: apps/mac
status: done
---

# mac: host JustApps assets through the daemon cache

## Problem

Frieren and Mac use the same app kernel, but the hosts do not yet use the same app
storage rule.

Frieren installs apps from `justapps.run` as hosted apps. The synced Volume keeps only:

- `/applications/<id>/manifest.json`;
- the reducer named by `manifest.app`, which is `app.js` for the current apps.

The service worker caches the GUI, icon, and other large files. The shared kernel mounts
these files through `FetchAsset` and checks each file against the hash in the manifest.

Mac does not pass `FetchAsset` to the kernel. It installs Code, Files, and Settings from
packaged directories and copies every file into the Volume. A hosted app record that
arrives on Mac cannot load its GUI or icon. Mac also has no persistent cache that can
make a hosted app work without the network.

The Bun daemon is the Mac equivalent of the Frieren service worker. It is the one host
layer used by all Mac consumers:

- the local HTTP route reads GUI files through `kernel.app(id).read(path)`;
- the native app projection reads icons through the same API;
- the shared install path prefetches mounted files through the same API.

Bun does not provide the browser `CacheStorage` API. Mac must implement this cache in
the daemon.

## Goal

Make Mac use the same source and storage rule as Frieren:

- An app from `justapps.run` is hosted. Keep its manifest and reducer in
  `/applications/<id>`. Keep its mounted files in `/private/cache`.
- An app with no download source is local. Keep its complete bundle in
  `/applications/<id>`. This includes apps made with App Code and apps imported from a
  local bundle or ZIP.
- A hosted app works offline after the existing install or reconcile prefetch completes.
- The shared kernel verifies every mounted file before it gives the bytes to a caller.
- The Mac daemon can start and run local or already cached apps when `justapps.run` is
  unavailable.

Do not add another app format or another source flag. `AppManifest.baseUrl` stays the
only rule that selects the hosted shape.

## Current facts

The shared app code already implements most of this design:

- `packages/app/app.ts` defines `baseUrl`, `files`, `isHosted`, and `isMountedFile`.
- `packages/app/kernel.app.ts` stores a hosted reducer in the Volume and mounts other
  files through an optional `FetchAsset`.
- `packages/app/appstore.ts` installs only the reducer for a hosted catalog entry. It
  also prefetches mounted files after install and during reconcile.
- A `baseUrl` change causes repair even when the app version does not change. This can
  convert an old complete bundle to the hosted shape without a migration script.
- `packages/sync/replica.ts` already excludes `/private/**` from sync and reserves
  `/private/cache/**` for reconstructible local data.

Frieren has two app-store adapters in `apps/frieren/shared/appstore.ts`:

- the legacy `/appstore` adapter for files built into Frieren;
- the JustApps adapter for `https://justapps.run/store.json`.

The live JustApps index contained Draw, Notes, and Paint on 2026-08-16. It did not
contain Code, Files, or Settings. Mac must keep its packaged store for these three apps
until hosted releases exist.

## Storage contract

### Hosted app

Example:

```text
/applications/justfiles.notes/
	manifest.json
	app.js

/private/cache/apps/
	<sha256-of-absolute-asset-url>
```

The installed manifest contains:

- the immutable release `baseUrl`;
- the whole-app hash;
- one `sha256-<hex>` pin for each mounted file;
- the reducer path and the GUI and icon paths.

The cache is derived data. It is not part of the installed app record. It does not
sync, and it can be deleted and rebuilt.

### Local app

Example:

```text
/applications/<id>/
	manifest.json
	app.js
	gui.js
	icon.png
	<other bundle files>
```

The manifest has no `baseUrl`. The shared kernel reads all files from the Volume. The
daemon cache is not used.

### Other derived data

The `.app` bundles under `~/Applications/Kodama Apps` stay a projection. They are not
an app source. The daemon continues to rebuild them from installed manifests and icons.

## Data flow

```text
justapps.run/store.json
	-> shared JustApps AppStore adapter
	-> materialise/reconcile
	-> /applications/<id>/{manifest.json,reducer}
	-> shared prefetch or app.read(path)
	-> Mac FetchAsset
	-> /private/cache/apps/<url-hash>
	-> network on a cache miss

WKWebView localhost route -----> kernel.app(id).read(path) -----^
native icon projection --------> kernel.app(id).read(icon) -----^

App Code or local import
	-> kernel.install(bundle without baseUrl)
	-> complete bundle in /applications/<id>
```

Keep `Cache-Control: no-store` on the daemon's localhost app response. The durable
cache is below the route, in the daemon. WebKit cache state must not decide whether an
app works. This also lets the native icon projection and install prefetch use the same
cached bytes.

## Implementation

### 1. Move the JustApps adapter to shared host code

Add `apps/shared/justapps.ts`.

Move these items from `apps/frieren/shared/appstore.ts`:

- `RUNNER_STORE_URL`;
- `RUNNER_STORE_SCHEMA`;
- `RUNNER_MANIFEST_SCHEMA`;
- `UPDATE_CHECK_INTERVAL_MS`;
- the trusted first-party ID list;
- the JustApps wire types;
- `RunnerCatalogApp` and `RunnerAppStore`;
- `runnerAppStore`;
- the store composition used by Frieren boot.

Keep the existing `Runner` names in the first change. A terminology rename does not
change behavior and is not required for Mac support.

Keep these Frieren-only items in `apps/frieren/shared/appstore.ts`:

- `CATALOG_SCHEMA` and `CATALOG_PATH`;
- `RUNNER_CACHE_NAME` and `RUNNER_CACHE_MAX_ENTRIES`, because Workbox uses them;
- `appBaseUrl` and `appFileUrl` for the built Frieren assets;
- `httpAppStore` for the legacy Frieren asset route.

The shared adapter must keep these rules:

1. Fetch `https://justapps.run/store.json`.
2. Require schema `justapps/store/v1` and an array of apps.
3. Load each mutable `manifestUrl` at most once per adapter instance.
4. Require schema `justapps/manifest/v1`, the requested app ID, and an array of files.
5. Derive `baseUrl` from the final manifest response URL. Do not accept an authored
   `baseUrl` from the manifest.
6. Return only the host allowlist from `builtins()`.
7. Let `latest(id)` resolve any app that is present in the index.
8. Let `catalog()` hydrate all valid entries for the Frieren store UI.
9. Return `null` for an invalid index, a non-success response, or a network exception.
10. Return `null` for one invalid or unavailable manifest without rejecting other apps.
11. Reject a file read when its HTTP response is not successful.

Add one small composition function in the same file. It accepts a primary `AppStore`
and a `RunnerAppStore` and returns one `AppStore` with these rules:

- the primary store wins when both stores have the same app ID;
- `builtins()` returns primary apps followed by non-duplicate trusted JustApps apps;
- `latest(id)` asks the primary store first;
- `read(app, path)` sends a JustApps catalog object to the JustApps store and all other
  objects to the primary store.

This is the exact composition that Frieren and Mac need. Do not add a general store
registry or a new interface to `@justfiles/app`.

Update Frieren to import the shared adapter and interval. Keep its external behavior
unchanged. Keep its packaged store authoritative.

### 2. Add the Mac asset cache

Add `apps/mac/daemon/app-assets.ts`.

Export one async factory:

```ts
appAssets(fs: Volume, request?: typeof fetch): Promise<FetchAsset>
```

The optional request argument is a test seam. Do not add cache methods to `Kernel` or
`Volume`.

Use these paths:

```text
CACHE_ROOT = /private/cache/apps
TMP_ROOT = /private/tmp/app-assets
cache key = lowercase hex SHA-256 of the complete absolute URL
cache path = <CACHE_ROOT>/<cache key>
```

Never use the remote host or path as a Volume path. The hash gives one flat,
path-safe name and includes the scheme, host, release path, and file path.

The factory does this work once:

1. Create `CACHE_ROOT` and `TMP_ROOT` with `recursive: true`.
2. Remove abandoned files under `TMP_ROOT`.
3. Prune `CACHE_ROOT` to at most 500 files. Sort files by `mtimeNs`, newest first,
   and remove the rest. This is an oldest-write policy, not a full LRU. Do not update
   timestamps on cache hits.
4. Return a `FetchAsset` with an `evict(url)` method.

The fetch function uses cache-first behavior:

1. Derive the cache path from the URL.
2. Return `fs.readFile(cachePath)` when it exists.
3. Use one in-process `Map<string, Promise<Uint8Array>>` to combine concurrent misses
   for the same URL.
4. Fetch the URL.
5. Require `response.ok`.
6. Read the response as `Uint8Array`.
7. Write the bytes to a unique file under `TMP_ROOT`.
8. Rename the temporary file to the final cache path.
9. Return the downloaded bytes.
10. Remove the in-flight entry in `finally`.

A new-name `Volume.writeFile` is atomic. The rename makes replacement atomic as well.
The daemon is the only native Volume writer, and the in-flight map prevents two writes
for the same URL in that daemon.

If the network request or response fails, do not write a cache file. Propagate the
error. If only the cache write fails after a successful download, remove the temporary
file, log one warning, and return the downloaded bytes. A cache problem must not stop
an online app from loading.

`evict(url)` derives the same path and removes it with `force: true`. It is
best-effort at the shared kernel call sites.

Do not verify the manifest hash in this module. `packages/app/kernel.app.ts` already
does that after every cache hit or network fetch. If cached bytes do not match the pin,
the kernel calls `evict(url)` and rejects that read. The next read fetches a clean copy.

The 500-file limit matches Frieren's current Workbox limit. Run pruning at daemon
start. Do not add a cache index, access log, database, or per-read timestamp write.

### 3. Let reinstall evict the previous hosted release

Update `packages/app/kernel.app.ts` in the existing atomic install path.

When install replaced an old root and the new root is committed:

1. Read the old manifest from the backup root.
2. Call the existing mounted-file eviction logic for that backup root.
3. Ignore eviction errors.
4. Remove the backup root as it does now.

Do this only after the new root is live. Do not evict the current app before a
successful commit. This removes old immutable release URLs after an update. The cache
limit remains the repair rule for crash leftovers and unreferenced files.

On uninstall, move the app to trash, then read that moved bundle's mounted URLs and
evict them. The atomic move ties eviction to the exact release that uninstall removed.

### 4. Compose the Mac app store

Change `apps/mac/daemon/builtins.ts` so it returns the boot store for Mac:

1. Build the existing packaged store for Code, Files, and Settings.
2. Try to build the shared JustApps store.
3. If JustApps is unavailable, return the packaged store.
4. If it is available, compose it behind the packaged store.

The packaged store stays primary. This prevents a remote entry from replacing an app
that this Mac release still owns as a packaged builtin.

Do not fail daemon boot when the JustApps index is offline or invalid. Existing local
apps and cached hosted apps must still work.

Keep these packaged apps in the first change:

- `justfiles.code`;
- `justfiles.files`;
- `justfiles.settings`.

The trusted JustApps list currently adds Notes and Paint. It also lets reconcile update
any other hosted app that is already installed.

### 5. Wire the cache into the Mac kernel

Update `apps/mac/daemon/kernel.ts`.

In `buildKernel(fs, accounts)`:

1. Create the asset cache after the app-ID migration and before kernel creation.
2. Pass it as `fetchAsset` in the existing `kernel({...})` options.
3. Build the composed Mac app store.
4. Run `materialise(k, store)`.
5. Run `reconcile(k, fs, store)`.

Do not add a `fetchAsset` option to `buildKernel`. Test the cache factory directly and
test hosted install behavior through the shared kernel. Keep the Mac kernel function
surface unchanged.

The existing shared paths then provide all required behavior:

- `materialise` installs missing trusted JustApps apps;
- hosted install writes only the reducer and rewritten manifest;
- install prefetch fills `/private/cache/apps`;
- reconcile warms hosted apps that arrived through sync;
- a changed `baseUrl` converts an old complete bundle to hosted storage;
- `kernel.app(id).read(gui)` reads from the daemon cache;
- icon projection reads from the same cache.

No change is required in the GUI or icon HTTP routes in `apps/mac/daemon/main.ts`.

### 6. Add the periodic update checkpoint

Frieren checks for app updates every six hours. Mac must use the same shared interval.

Keep timer ownership in the process singleton path, not in every `buildKernel` call.
Tests call `buildKernel` directly and must not create background timers.

Refactor the boot work into one private function in `apps/mac/daemon/kernel.ts`:

```ts
refreshApps(kernel, fs, seedMissingBuiltins: boolean): Promise<void>
```

It creates a fresh composed store each time. A fresh store fetches the current mutable
manifest pointers.

- On boot, call it with `true`; run `materialise` and then `reconcile`.
- On each interval, call it with `false`; run only `reconcile`.

Use the existing `coalesce` helper so update passes never overlap. Start the interval
only from `getKernel()` after boot succeeds. Call `unref()` on the timer when the
runtime supports it. Catch and log a checkpoint failure so it cannot terminate the
daemon.

Do not add a Volume watch for synced app records in this change. Mac does not yet wire
Volume sync. The existing boot reconcile will warm records after restart. A later Mac
sync task can trigger the same private refresh after an `/applications` change.

### 7. Keep local app installation complete

Do not change App Code install or the direct kernel install API.

`appBundleFromMemory` and other local bundles have no `baseUrl`. The existing shared
kernel therefore writes every supplied file to `/applications/<id>`. Add an integration
assertion so later hosted work cannot change this rule by accident.

When ZIP import is added or restored, it must use the same local bundle shape unless
the import contains a host-validated, immutable source. A bundle-authored URL alone
must never select hosted storage.

### 8. Retire packaged app seeding in small steps

Do not remove the packaged Code, Files, or Settings builds in the first change. They
do not yet have a source in the live JustApps store.

For each app after a hosted release exists:

1. Add it to the trusted JustApps allowlist if it must be preinstalled.
2. Remove it from `BUILTINS` in `apps/mac/daemon/builtins.ts`.
3. Remove its copy step from `apps/mac/native/build.sh`.
4. Remove its Mac workspace build dependency when no other Mac build step needs it.
5. Boot an existing profile and confirm that reconcile changes it from complete local
   storage to the hosted shape without a version bump.

After the last packaged app is removed, delete only the now-unused parts:

- `builtinStoreFromFs` use in Mac;
- `BUILTINS_DIR` from `apps/mac/daemon/resources.ts`;
- `Contents/Resources/builtins` build and copy logic;
- obsolete Mac package dependencies and build comments.

Do not remove shared legacy app-store code used by another host in the same change.

## Tests

Use Vitest for all new tests.

### Shared JustApps adapter

Move the existing adapter tests with the adapter. Cover:

- valid index and manifest conversion;
- invalid index schema;
- invalid manifest schema or app ID;
- final response URL used as `baseUrl`;
- one manifest request for repeated access;
- only the trusted allowlist returned from `builtins()`;
- invalid catalog entries omitted without loss of valid entries;
- top-level network rejection returns `null`;
- non-success file response rejects;
- primary store precedence in composition;
- `read` sent to the correct source.

Keep Frieren tests for its `/appstore` adapter and Workbox-specific constants in
Frieren.

### Mac cache unit tests

Add `apps/mac/daemon/app-assets.test.ts` with a memory `Volume` and a fake request.
Cover:

- first read fetches and stores bytes;
- second read returns the stored bytes when the network is offline;
- two concurrent misses make one network request;
- a non-success response is not cached;
- a rejected request is not cached;
- `evict(url)` removes only that URL;
- a cache name is a flat hash and does not contain remote path text;
- start removes abandoned temporary files;
- start keeps the newest 500 cache files and removes older files.

### Hosted and local integration tests

Add a standard Vitest integration test with a memory `Volume`, a fake hosted
`AppStore`, and the shared kernel.

For a hosted app:

1. Install through `installApp`.
2. Assert that `/applications/<id>` contains only `manifest.json` and the reducer.
3. Assert that GUI and icon files are absent from the app root.
4. Assert that prefetch placed mounted files under `/private/cache/apps`.
5. Disable the fake network.
6. Read the GUI and icon through `kernel.app(id).read(path)`.
7. Assert the cached bytes are returned.
8. Return wrong cached bytes, assert a hash mismatch, and assert eviction.

For a local app:

1. Install an `appBundleFromMemory` with reducer and GUI.
2. Assert that all files are under `/applications/<id>`.
3. Assert that no asset request occurred.

### Update and cleanup tests

Add a shared kernel regression test:

- install hosted release A;
- install hosted release B over it;
- assert release A mounted URLs are evicted only after release B commits;
- make release B fail before commit and assert release A is not evicted.

Update `apps/mac/daemon/server.bun.test.ts` to use Files for its state socket test. Mac
packages Files, but it does not package Notes. This removes an old hidden dependency on
remote seeding. Do not add new Bun tests.

Tests for `buildKernel` must stay valid when the registry is offline. They must not
depend on the live JustApps response.

## Documentation changes with implementation

Update these documents after the behavior works:

- `apps/mac/README.md`: explain hosted and local app storage, offline prefetch, and
  continued packaged fallback.
- `apps/mac/DESIGN.md`: replace statements that say all app bytes are in the Volume.
- `docs/app.md`: add the Mac host cache beside the Frieren service-worker example if
  the host responsibility is not already clear.

Keep the documents explicit that `/applications` is the installed-app source of truth.
`/private/cache` and native `.app` bundles are derived host data.

## TDD implementation order

### Cycle 1: shared adapter

**RED:** Move or add the JustApps adapter tests, including top-level network failure and
primary-store precedence.

**GREEN:** Extract `apps/shared/justapps.ts` and change Frieren imports without behavior
change.

### Cycle 2: Mac asset cache

**RED:** Add the cache miss, hit, offline, concurrency, eviction, cleanup, and bound
tests.

**GREEN:** Add the one `appAssets` factory with flat URL hashes, atomic writes, and
startup pruning.

### Cycle 3: storage shape

**RED:** Add hosted and local install integration tests.

**GREEN:** Pass the cache to the Mac kernel and compose the packaged and JustApps
stores.

### Cycle 4: update cleanup

**RED:** Add successful and failed replacement eviction tests.

**GREEN:** Evict mounted files from the old backup only after the new root commits.

### Cycle 5: update checkpoint

**RED:** Add tests for an offline store and two coalesced update triggers. Assert that a
direct `buildKernel` does not create a timer.

**GREEN:** Add the singleton-owned six-hour refresh and recreate the store for each
pass.

### Cycle 6: documentation and legacy drift

Update the Mac documents and the old Notes server test. Keep the three unpublished
packaged apps.

## Verification

Run targeted tests during each cycle. Before review, run the repository checks:

```sh
pnpm run format
pnpm run typecheck
pnpm run lint:fix
pnpm run test
```

Review any file changed by format or lint before commit.

For a manual Mac smoke test:

1. Start the daemon with an empty test profile while online.
2. Confirm that trusted hosted apps appear and launch.
3. Inspect the Volume. Confirm that each hosted app root has only the manifest and
   reducer and that `/private/cache/apps` contains hashed files.
4. Stop the daemon and block access to `justapps.run`.
5. Start the daemon again. Confirm that hosted app GUI and projected icons still work.
6. Create an App Code app. Confirm that its reducer and GUI both stay in its
   `/applications/<id>` directory.
7. Restore the network, publish or select a newer hosted release, run a refresh, and
   confirm that the old release cache files are removed.

## Acceptance criteria

- [ ] Mac and Frieren use the same shared JustApps adapter.
- [ ] Mac passes a persistent cache-backed `FetchAsset` to the shared kernel.
- [ ] A JustApps app stores only its manifest and reducer under `/applications/<id>`.
- [ ] Hosted GUI, icon, and asset files stay under `/private/cache/apps` on Mac.
- [ ] A prefetched hosted app works after daemon restart with no network.
- [ ] A hosted app received through a later sync can be warmed by reconcile without a
      local install record from the catalog UI.
- [ ] Hash mismatch rejects the bytes and evicts the exact cache entry.
- [ ] Concurrent reads of one uncached URL make one network request.
- [ ] Cache and registry failures do not stop the daemon from running local or already
      cached apps.
- [ ] Cache startup removes temporary files and keeps at most 500 asset files.
- [ ] Hosted update and uninstall remove cache files that their old manifest names.
- [ ] App Code and other source-less local apps keep their complete bundle in the
      Volume.
- [ ] Mac keeps Code, Files, and Settings packaged until each has a hosted release.
- [ ] Existing complete first-party bundles convert to hosted storage through normal
      reconcile, without a one-off migration or version bump.
- [ ] The daemon's GUI route and native icon projection need no separate cache logic.
- [ ] New tests use Vitest, and all repository verification commands pass.

## Out of scope

- Adding Mac Volume sync.
- Adding a Mac app-store browse or install UI.
- Adding ZIP import.
- Using WebKit service workers or WebKit HTTP cache for hosted app durability.
- Changing the reducer sandbox, capability model, or app author API.
- Adding a cache database, true LRU accounting, background download queue, or retry
  service.
- Removing a packaged app before its immutable hosted release exists.
