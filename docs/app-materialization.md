# App materialisation & updates (ship-now fix)

Status: proposal / design. No code yet. Companion to
[`docs/path-based-sync.md`](./path-based-sync.md) — that doc fixes sync identity
at the root; **this doc is the smaller, ship-now change** that stops the app
from getting stuck/forked without waiting on the sync rewrite.

## TL;DR

Today built-in apps are materialised into `/applications/<id>/*` by **two
authorities**: the server (DO reconcile) *and* the client (`seedBuiltins`). Two
authorities minting inodes for the same path is what forked the incident profile
(see the path-based-sync doc for the identity analysis).

Adopt the desktop mental model:

1. **Materialise once, client-only, on first run** (empty volume). A returning
   user keeps whatever is on their volume — like a computer that already has apps
   installed.
2. **Updates are a separate, client-initiated feature** (macOS-style): per-app
   on launch, plus a system-wide "check for updates" sweep. **Monotonic — never
   downgrade.** Applies locally, then syncs up.
3. **The server never materialises or mutates `/applications/*` and syncs it
   down.** It is sync/backup, and it holds the apps so the agent can reach them.
   The client owns its files.

Because materialisation becomes **single-origin (client only)**, the fork can't
happen even under today's ino-based sync — the server just receives the client's
inodes via sync-up. (The path-based sync doc is still the robust general fix for
multi-device concurrent updates; this change removes the common-case failure.)

Also folded in: **restore the per-file self-heal** that the `.apphash` change
regressed, and **quiesce a running app when its bundle changes**.

---

## Context: current behaviour (what to change)

- `packages/app/appstore.ts` — `reconcile(kernel, fs, store)` installs missing
  built-ins and updates changed ones. Change is decided by the whole-app
  `.apphash` (my recent change). `sync()` reinstalls via `kernel.install`
  (atomic tmp→rename).
- **Server** runs it: `apps/frieren/worker/frieren.app.ts` →
  `ensureBuiltinsInstalled` → `reconcileFromAssets` (DEV: every kernel use; prod:
  once per instance). **This is the server-side materialisation we remove.**
- **Client** runs it too: `apps/frieren/src/apps/seed.ts` → `seedBuiltins`,
  invoked from `apps/frieren/src/os/Provider.tsx` behind the gate:
  ```ts
  const hasRemoteUser = activeProfileHasRemoteUser()
  if (hasRemoteUser && (!isLoaded || isSignedIn)) return  // racy: see below
  await seedBuiltins(await localKernel(), fs)
  ```
- `apps/frieren/src/apps/host.ts` — a running app's GUI loads `gui.js` **once**
  at boot; the reducer (`app.js`) is re-read per dispatch. The host watches
  `/state/<id>.json` for remote state, but **does not watch
  `/applications/<id>/*`** and **never closes/reboots a running app** when its
  bundle changes.
- `packages/app/kernel.ts` — `install()` emits `app.installed`; host re-lists the
  launcher but doesn't quiesce the open app.

Two defects to fix alongside the model change:

- **Self-heal regressed.** My `.apphash` change made `reconcile` trust the
  `.apphash` marker alone; it no longer verifies each file is present. A missing
  file (partial install / un-hydrated stub) is not repaired.
- **No quiesce.** A bundle change under a running app ⇒ old GUI ↔ new reducer,
  possible state-shape mismatch, torn reads mid-swap.

---

## Decisions (the rules to implement)

### R1 — Single materialiser, client-only, once

- **Local-only profile:** if the volume is empty of built-ins, the client
  materialises them from the PWA-precached `/appstore` assets. (No server.)
- **Synced profile:** the client materialises **only after the first bootstrap
  has completed and the volume is still empty** (⇒ genuinely new account). If
  bootstrap brought apps down, do nothing.
- **Server:** never materialises. Remove `ensureBuiltinsInstalled` /
  `reconcileFromAssets` from the worker. The DO receives apps via the client's
  sync-up.

### R2 — Boot is a barrier only when there's no local state

- Synced profile with **no usable local replica** (fresh login / new device):
  block on first bootstrap ("nobody moves") before the materialise decision.
  `App.tsx` already does `await vol.flush()` after `attachRemoteUser` — hang the
  decision off that.
- Otherwise (replica already present): local-first boot, reconcile/update in the
  background.

### R3 — Updates are client-initiated and monotonic

- Trigger: on app launch (check that one app) and a system "check for updates"
  sweep (all apps). No server-initiated updates.
- Decision uses `.apphash` (whole-app hash) for "changed", **plus a monotonic
  guard**: apply only if the store's version `>=` the installed version. Never
  downgrade (protects against a stale client build re-writing a newer app).
- Repair (self-heal) is exempt from the monotonic guard: a *missing/corrupt*
  file reinstalls the same version.
- Applies via the **client** kernel; the write syncs up.

### R4 — Quiesce on bundle change

When `/applications/<id>/*` changes — from a local update **or** a
`REMOTE_SOURCE` sync pull — close/reboot the app: stop dispatches, tear down the
GUI stage + drop the cached sandbox, then reboot from the new bundle (reset or
migrate state if the version changed).

### R5 — Built-ins are uninstallable

Drop reconcile's "always reinstall a deleted built-in". Deleting is the user's
choice. A "restore default apps" affordance can come later; the update sweep may
*offer* a missing app but never forces it.

---

## Concepts in code

### Update decision (proposed shape for `packages/app/appstore.ts`)

```ts
// Decide what reconcile does for one app. Split "repair" from "upgrade" so the
// monotonic guard only governs version changes, and a missing file is always
// repaired.
type SyncAction = 'skip' | 'repair' | 'upgrade'

async function decide(fs: Volume, app: CatalogApp): Promise<SyncAction> {
	if (!(await filesPresentAndMatch(fs, app))) return 'repair'   // self-heal (restored)
	if ((await installedHash(fs, app.id)) === (await appHash(app))) return 'skip'
	// Whole-app hash differs → an upgrade, but never downgrade.
	return semverGte(app.version, await installedVersion(fs, app.id)) ? 'upgrade' : 'skip'
}
```

- `appHash` / `installedHash` (the `.apphash` marker) — already implemented.
- `filesPresentAndMatch` — **restore** the per-file `fs.stat().contentHash` loop
  I removed (excluding `manifest.json`, which is re-serialised on install).
- `installedVersion` — **restore** the manifest-version read for the monotonic
  guard.

### Client is the sole entry point

- Remove the worker's reconcile call. `reconcile` (renamed intent: "materialise
  if empty + update installed") is invoked only by the client:
  - first-run materialise (R1/R2), and
  - launch/sweep updates (R3).

### Quiesce signal (host)

The kernel already emits `app.installed` on `install`. For R4 the host also needs
to react to **sync-applied** bundle changes (the agent/another device updated the
app; it arrives as a `REMOTE_SOURCE` write to `/applications/<id>/*`), mirroring
the existing `/state/<id>.json` watch in `host.ts`:

```ts
// host.ts bootLocal(): alongside the existing state watch, watch the bundle.
stage.unwatchBundle = await vol.watch(`/applications/${stage.id}/manifest.json`, (e) => {
	if (e.source !== REMOTE_SOURCE || stage.cancelled) return
	appHost.close(stage.id)          // tear down GUI + drop sandbox (blocks dispatch)
	appHost.open(stage.id, opts)     // reboot from the new bundle
})
```

Local updates (R3) go through `kernel.install` → `app.installed`; the host's
existing catalog subscription plus a close/reopen on that event covers them.

---

## Where the changes land (focused)

1. `packages/app/appstore.ts` — `decide()` (repair vs upgrade vs skip); restore
   `filesPresentAndMatch` + `installedVersion`; add the monotonic guard; drop the
   "always reinstall deleted built-in" rule (R5). Add a per-id entry point for
   launch-time checks (the sweep is just "for each installed id").
2. `apps/frieren/worker/frieren.app.ts` — remove `ensureBuiltinsInstalled` /
   `reconcileFromAssets`; the worker no longer materialises.
3. `apps/frieren/src/os/Provider.tsx` + `src/apps/seed.ts` — gate materialisation
   on R1/R2 (after first bootstrap, empty ⇒ materialise once); wire launch/sweep
   updates.
4. `apps/frieren/src/apps/host.ts` — R4 quiesce: watch the bundle for
   `REMOTE_SOURCE` changes; close+reboot on local update events too.

Not touched: the sync engine itself (that's the path-based-sync doc).

---

## Verification: red → green (TDD)

Unit-testable parts live in `packages/app/appstore.test.ts` (existing harness:
`fakeWorld()` + in-memory store). Each RED fails today; must pass (GREEN) after
the change. Run `pnpm vitest run packages/app/appstore.test.ts`.

### RED 1 — self-heal a missing file (the regression)

```ts
test('reinstalls when a file is missing even if .apphash matches', async () => {
	const store = await builtinStore(FILES)
	const { kernel, fs, installs, blobs } = fakeWorld()
	await reconcile(kernel, fs, store)                 // installs, writes .apphash
	blobs.delete('/applications/app.x/icon.png')       // simulate a lost/un-hydrated file
	await reconcile(kernel, fs, store)
	expect(installs).toEqual(['app.x', 'app.x'])        // repaired
})
```
RED today: `.apphash` matches ⇒ skipped ⇒ the missing file is never repaired.

### RED 2 — never downgrade

```ts
test('does not reinstall when the store version is older than installed', async () => {
	const { kernel, fs, installs } = fakeWorld()
	await reconcile(kernel, fs, await versionedStore('0.1.1'))  // installed 0.1.1
	await reconcile(kernel, fs, await versionedStore('0.1.0'))  // stale build offers 0.1.0
	expect(installs).toEqual(['app.x'])                          // no downgrade
})
```

### GREEN-keep — existing upgrade/skip cases

```ts
// still pass: upgrade on newer version, skip when unchanged, content-change at
// same version still upgrades (dev iteration), hash-mismatch is rejected.
```

### RED 3 — built-in stays uninstalled

```ts
test('a deleted built-in is not force-reinstalled', async () => {
	const store = await builtinStore(FILES)
	const { kernel, fs, installs } = fakeWorld()
	await reconcile(kernel, fs, store)
	await kernel.uninstall('app.x')                    // user removes it
	await reconcile(kernel, fs, store)
	expect(installs).toEqual(['app.x'])                 // NOT reinstalled
})
```
RED today: reconcile reinstalls every missing built-in.

### Integration / UI checks (not unit tests)

Per `AGENTS.md`, use LLM-driven smoke checks for frieren UI, not full e2e:

- **R1/R2 no double-seed:** fresh signed-in profile → after bootstrap the DO's
  apps appear; the client does **not** re-materialise (verify only one
  `/applications/<id>` lineage; no duplicate/phantom via the sync journal). This
  is the incident reproduction.
- **Server does not materialise:** a fresh DO volume with no client sync stays
  empty (reconcile is never called server-side).
- **R4 quiesce:** open an app; push a bundle change (bump version, sync down) →
  the open window reboots into the new version; no old-GUI/new-reducer mismatch;
  no torn read.

Definition of done: RED 1–3 pass; existing appstore tests still pass; the
incident is reproduced-then-fixed by the R1/R2 integration check.

---

## Sequencing & relationship to path-based sync

- **This doc ships first.** Single-origin materialisation + monotonic updates +
  self-heal + quiesce removes the common-case fork and the stuck-app symptom
  under today's ino-based sync.
- **[`docs/path-based-sync.md`](./path-based-sync.md) is the root fix.** It makes
  forks structurally impossible (path identity) and unblocks heterogeneous-backend
  sync (spud-mac ↔ frieren). This doc's single-origin rule is a workaround that
  holds for single-device and adopt-then-update flows; concurrent updates to the
  same app on two devices still want path-based identity to converge cleanly.

## Open questions

- First-run "empty" signal: check `/applications` empty, or a dedicated
  `trusted.materialised` marker written once? A marker is more robust against the
  bootstrap race than an emptiness check.
- Update UX: silent auto-update on launch vs. an explicit "Updates available (N)"
  affordance + system sweep. Recommend auto for built-ins, surfaced for the sweep.
- Agent before first sync: the DO has no apps until the client materialises and
  syncs up — acceptable? (Agent-only flows on a brand-new account would wait.)
