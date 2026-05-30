# Frieren local-first plan

Goal: make Frieren a local-first PWA. A browser-local volume becomes the
working copy; the backend becomes a synced replica. General apps (paint, later
notes / code) run entirely in the browser and keep working offline. AI / email /
calendar / integrations degrade gracefully when offline.

This plan is **incremental and reversible**. Each phase ends with the app
functioning 100% (online), so we can ship and verify between phases. The one
place where "invisibly non-breaking" is genuinely hard is called out in Phase 2.

---

## Background: how it works today

- The backing volume lives **server-side** in the `Frieren` Durable Object
  (`volume(cfFsStorage(...))`), exposed to the FE over `/fs` via `createFsApi`.
- **App logic runs server-side.** A GUI runs in the browser but dispatches every
  action over a WebSocket (`/api/apps/<id>/ws`) to a Worker-Loader sandbox in the
  DO. The `volume` capability executes server-side (`worker/volume.capability.ts`).
- The **kernel is fully volume-backed**: app code, app state, and app data all
  live in the FS. Nothing else stores them.
- The **agent dispatches app actions too** (`controller.run`, `actor:'agent'`),
  and runs headless (daily alarms / scheduled work), so a server-side executor
  must continue to exist.

### Filesystem layout (the unit we sync)

| Path                       | Contents                                                    | Written by                        |
|----------------------------|-------------------------------------------------------------|-----------------------------------|
| `/applications/<id>/`      | installed app bundle (`app.js`, `gui.js`, manifest, assets) | install flow (`kernel.ts:86`)     |
| `/state/<id>.json`         | kernel-persisted per-app state                              | kernel (`kernel.ts:226`)          |
| `/data/<id>/…`             | per-app user data (chroot via `volume` cap)                 | app via `volume` capability       |
| `/system/os-state.json`    | window layout / focus / agent-open                          | FE shell (`os/persistence.ts`)    |
| `/system/profiles/user.md` | user profile (frontmatter)                                  | FE onboarding (`UserProfileStep`) |
| `/system/soul.md`          | agent soul                                                  | FE onboarding (`AgentStep`)       |

### Why two kernels is safe (no logic duplication)

App logic is **not** compiled into either build. The kernel loads it from the
volume: `code: text(await app.read(app.manifest.app))` (`kernel.ts:236`),
content-addressed by SHA-256 (`kernel.sandbox.ts`). So the browser kernel and the
server kernel read the *same* `/applications/<id>/app.js` from the *same synced
FS*. They cannot diverge except by transient sync lag, which self-heals (new
bytes → new content hash → fresh isolate; last-writer-wins converges).

The only thing compiled into both builds is the thin **kernel runtime**
(`@justfiles/app`). Its two contracts must stay stable across deploys:
1. on-disk state format — `/state/<id>.json` plain JSON;
2. dispatch contract — `{type, params}` in, new state out.

Constraint this imposes on apps: `app.js` must be **environment-agnostic** (pure
logic + injected capabilities, no DOM, no platform globals) so it runs in both a
CF Worker-Loader isolate and a browser Web Worker. The capability model already
enforces this; paint already complies.

---

## Target architecture

- **Browser kernel** runs `app.js` in a Web Worker against the synced local
  volume; executes the user's actions, offline-capable.
- **Server kernel stays** and executes the agent's actions headless.
- **One synced volume = the whole truth.** Both kernels read/write their own
  replica; `synced.ts` reconciles via mtime-based last-writer-wins with a
  local-bias tiebreak (`local mtime >= remote → local wins`).
- **Capabilities split** (see table below): `volume` is local in the browser;
  network capabilities proxy to the server and are unavailable offline.
- **PWA**: service worker caches the shell and prefetches installed app bundles
  so the whole OS — and every installed app — loads offline.

### Capability split

| Capability           | Browser kernel                         | Offline                         |
|----------------------|----------------------------------------|---------------------------------|
| `volume`             | local synced volume (chroot per scope) | ✅ works                        |
| `ai`                 | proxy → server over WS                 | ❌ rejects `CAPABILITY_OFFLINE` |
| `integrations`       | proxy → server over WS                 | ❌ rejects                      |
| `email` / `calendar` | proxy → server over WS                 | ❌ rejects                      |

---

## Phase 0 — Synced local volume (transparent swap)

Replace the remote-only FE volume with a synced local volume. No consumer API
changes; apps untouched (still server-side over WS).

**Changes**
- `src/fs.ts`: `createFsVolume` returns `synced({ local: idbStorage(dbName),
  remote: await apiStorage(createFsClient(getToken)), lazyContent: true })`
  (mirrors `apps/worker/src/react-app/useVolume.ts:322`).
- Make it a **singleton volume manager** shared by `App.tsx:43` and
  `os/Provider.tsx:15` (today they create two separate volumes).
- **Per-user IDB name** (`frieren-fs-<userId>`) and **destroy + delete IDB on
  sign-out / user switch** — Frieren supports user switching (`AuthWall`), so a
  previous user's local volume must never leak into the next.
- **Debounced, online-aware flush**: `synced` already runs on an interval with
  retry/backoff and exposes `flush()/pause()/resume()`. Wire `flush()` to a
  debounced write trigger + `pagehide`/`visibilitychange`; wire
  `pause()/resume()` to `navigator.onLine` / `online`/`offline` events.
- **Onboarding durability**: onboarding completion writes `soul.md`/`user.md`,
  which the server agent reads. With debounced flush these might not reach the
  backend before the agent first needs them — so `await flush()` on onboarding
  completion before entering the OS.

**Files**: `src/fs.ts` (new manager module), `src/App.tsx`, `src/os/Provider.tsx`.
Imports: `@justfiles/fs/storage/idb`, `synced` from `@justfiles/fs`.

**Still 100% functional?** Yes. OS-state + onboarding reads/writes now go through
the local cache and sync to the *same* backend. Apps keep working over WS — their
server-side writes simply sync *down* into the client cache. The server volume
gains a second writer (client push), which is exactly the proven `apps/worker`
model; `synced.ts` already handles it.

**New capability unlocked**: OS-state and onboarding reads serve from the local
cache *within a session*. (Surviving a full **reload** offline needs the PWA
shell cache — Phase 3; the shell JS + Clerk still require network until then.)

**Verify**: `pnpm format && pnpm typecheck && pnpm lint:fix && pnpm test`, then
`verify:ui` — onboarding completes, window layout persists across reload, apps
open. Then: with the app loaded, go offline in devtools, move a window → layout
still saves (to IDB); reconnect → it syncs to the backend.

**Risks**: first boot runs `bootstrap()` (full scan of the server volume,
metadata only thanks to `lazyContent`). Acceptable; same as worker.

---

## Phase 1 — sync everything (no exclusions)

**Decision: sync the entire volume, including all of `/system`.** Two reasons
this is correct, not just simpler:

- Offline does **not** depend on sync policy. The local IDB is the working copy,
  so everything is already offline-capable from Phase 0. Marking a file
  "local-only" only stops it roaming to the backend — it does nothing for
  offline.
- The **server agent depends on `/system/os-state.json`**: `frieren.app.ts`
  `currentAppId()` reads it from the server volume to resolve "close the current
  app." If the client didn't push os-state, the server's view would go stale.
  So os-state must sync.

Conflict risk is low: os-state has a **single writer** (only the client writes
it; the server only reads). Multi-device concurrent sessions are the only
conflict source → last-writer-wins on window layout, which is rare and
low-stakes. (The shell should clamp restored windows on-screen for differing
display sizes.)

The only local-only paths are the sync layer's **own** bookkeeping
(`/.state/clientid`, `/.state/sync`), which `synced.ts` already marks
automatically (`initStateMarkers`). No app/user file needs exclusion.

**Files**: none beyond Phase 0 — there is nothing to exclude.

**Still 100% functional?** Yes — this is the default behaviour of the synced
volume; this phase is really just "confirm we don't add exclusions."

---

## Phase 2 — Browser kernel + client-side app execution (the big one)

Run `app.js` in the browser against the synced volume. Ship behind a flag so
`main` stays 100% functional throughout.

### Phase 2a — build it dormant (flag OFF by default)

**Changes**
- `src/apps/sandbox.worker.ts` — a `GetSandbox` that loads `app.js` into a Web
  Worker, mirroring the server `workerSandbox` dispatch contract
  (`worker/kernel.sandbox.ts`).
- `src/apps/capabilities.client.ts` — the client capability bridge: `volume` →
  local synced volume; `ai`/`integrations`/`email`/`calendar` → **proxied to the
  server**. Offline → reject `CAPABILITY_OFFLINE`.
  - **New WS frame.** Today's WS is *action-level* only (`{id, action}` →
    `kernel.dispatch`, `frieren.app.ts:269`). Capability proxying needs a new
    *capability-invoke* frame (`{id, capability, method, input, scopes, appId}` →
    `result`/`error`), routed server-side to the existing `invokeCapability`.
  - **Server re-authorizes.** Scoping is enforced *inside* the server sandbox
    today; once the client invokes capabilities directly, the server must **not**
    trust the client-claimed `appId`/`scopes` — it re-derives them from the
    installed manifest before invoking. This is a new trust boundary.
- **Reuse one volume-capability implementation.** Move
  `worker/volume.capability.ts` (pure `Volume` ops — `resolveVolume` scoping,
  read/write/scan) into a shared location both server and client import, so
  scope resolution can't diverge.
- `src/apps/kernel.client.ts` — `kernel({ fs: syncedVolume, sandbox:
  browserSandbox })`. The host subscribes to **this kernel's in-process events**
  for local-dispatch state push (the client-side analog of the server's
  `kernel.subscribe → app.update`; replaces the WS `state` frame for local apps).
- `src/apps/host.ts` — behind a per-app flag (default off), dispatch to the local
  kernel instead of the WS. GUI is still loaded via dynamic import of `gui.js`
  (server-served for now; served from the local volume in Phase 3).

> **Cold start**: the client kernel runs an app only once its bundle is present
> in the local volume — bare `kernel()` does **not** auto-install builtins (that
> is `frieren.app.ts` wrapper logic). Bundles install server-side and sync down,
> and their blobs hydrate on first read (`lazyContent`). So a brand-new device
> must be **online for the first sync** before any app runs offline. Acceptable,
> but explicit.

**Still 100% functional?** Yes — flag defaults off, so behaviour is identical to
today. New code ships dormant.

**Verify**: in dev, turn the flag on for paint. Online: draw, autosave, reload,
state restored. *Within-session* offline: with paint open, disconnect, draw →
keeps working (writes to IDB); reconnect → syncs to backend; the server kernel
(and agent) sees the synced state. (Surviving a *reload* while offline is a
Phase 3 capability — `gui.js` and the shell still need network until then.)

### Phase 2b — make local execution the default

Flip the flag's default to on, so **every app runs locally** with its state
always sourced from the local volume. Apps that need network capabilities still
run locally — only those `ai`/`integrations`/`email`/`calendar` *calls* go over
the WS (and fail with `CAPABILITY_OFFLINE` when offline). The WS is no longer
used for dispatch or state — only as a capability proxy.

The flag itself **stays** (now narrowing-only: `VITE_FRIEREN_LOCAL_APPS=0` opts
back onto the server kernel) as the reversibility lever for Phases 2b–3. It and
the whole server-kernel FE path are deleted in **Phase 3.5**, once Phase 3 is
validated and the rollback is no longer load-bearing.

**The server stops pushing state.** Because the kernel is **stateless between
dispatches** — it loads state fresh from `/state/<id>.json` each dispatch
(`kernel.ts:166`) — the server never needs to *monitor* the volume: the agent
just reads current state when it next dispatches, and client changes have synced
in by then. So the server's state-push machinery (`ensureSubscribed` → WS
`state` frames, `frieren.app.ts`) is retired for client-side apps; the only
remaining server→client need is delivering the agent's *own* changes to an open
app, which the client picks up via sync, below.

**The genuinely hard part (flagged per your request).** When the *agent* (server
kernel) acts on an app you have open, it writes `/state/<id>.json` on the server
replica; that change syncs down and must re-render the open browser app. The
kernel being stateless means only the **GUI's displayed copy** needs refreshing;
the next dispatch picks up the new file on its own. We deliver this with a watch
primitive:

#### `volume.watch(path, fn)` — an inotify-style primitive

Add a watch API to the volume. `watch('/state/<id>.json', fn)` fires `fn` when
that file changes (content or meta), mirroring Linux inotify / macOS FSEvents.
The host watches each open app's state file (and later its open *document*,
e.g. `watch('/data/app.frieren.paint/my_drawing.paint', rerender)`), and on fire
re-reads and pushes fresh state/content to the GUI via the **same channel the WS
`state` frame used** (`host.ts:234`).

Implementation constraints (verified against the code):

- **Detect at the Storage layer, not the Volume layer.** Sync applies remote
  changes via `applyOp` **directly to the underlying `Storage`**
  (`synced.ts`: `applyOp(op, props.remote, props.local, …)`), bypassing the
  `volume` wrapper. Local writes go `volume → storage`; remote pulls go
  `applyOp → storage`; both hit the *same* `props.local` Storage. A volume-level
  interceptor would see local writes but **miss every agent change** — the exact
  events we want. So drive `watch` from a **Storage change feed**: add an optional
  `subscribe` to `StorageCapabilities`, have `idbStorage` emit
  `(ino, kind, source)` on **every** mutation entry point —
  `setMeta`/`putBlob`/`putDirent`/`deleteInode`/`deleteDirent` **and the atomic
  caps `atomicCreate`/`atomicMove`** (idbStorage implements both,
  `storage.idb.ts:418,457`; `volume.ts` uses them for create/rename, so omitting
  them would drop create/rename events). Wrap `props.local` so both `synced`'s
  internal `localVol` and `applyOp` feed one stream. `volume.watch` resolves
  `path → ino` (`resolvePath`) and subscribes.
- **Watch the inode *and* the parent dentry.** `writeFile` reuses the ino for an
  existing path (`volume.ts:418`), and remote content edits arrive as
  `upsert-inode` on the *same* global ino — so an ino-keyed watch catches the
  common case. But a delete+recreate or rename/replace re-points the path to a
  new ino (`applyOp` `set-dirent` drops the old ino). So `watch` must also
  re-resolve when the parent `(dirIno, name)` dirent changes — like real inotify
  watching inode + dentry.
- **Filter by `source`.** `MutationOptions.source` already exists; sync tags
  remote-applied writes `REMOTE_SOURCE`, local user writes carry none. So `watch`
  can fire only on changes this session didn't originate → no self-trigger loops.
- **Coalesce** per-ino to a microtask (one logical write = several storage ops).
- **Lifecycle**: `watch` returns an unsubscribe; the host unwatches on
  window/app close.
- **Bonus**: the same change feed can invalidate `localVol`'s `metaCache`/
  `dirCache`, fixing a latent staleness bug (today a pull writes to storage but
  never invalidates the volume's caches; `stat` can return stale meta after a
  pull — reads dodge it only because `readFile` is uncached, `volume.ts:411`).

This `watch` primitive is the one spot where Phase 2b is **not** invisibly
non-breaking: it is new work in `@justfiles/fs`. Local user actions are
unaffected. Acceptance for 2b includes `volume.watch` + host wiring. The
primitive is reusable beyond app state — open documents react to remote edits the
same way.

#### Scope & testing of the `@justfiles/fs` changes

The fs changes are **additive except one**: `volume.watch` (new method) and the
storage `subscribe` cap (new optional cap) add surface without touching existing
behaviour; the cache-invalidation hook **changes** read-after-pull (a fix for
stale `stat` after a pull). `@justfiles/fs` is shared — **`apps/worker` also
uses `synced`** — so that one behaviour change must be regression-checked there.

Tests to add in `packages/fs`:
- `subscribe` cap fires on each mutation kind, incl. `atomicCreate`/`atomicMove`,
  and carries the right `(ino, kind, source)`; no-op (near-zero cost) with no
  listeners.
- `volume.watch`: fires on content/meta change of the resolved ino; fires on
  parent-dentry rebind (delete+recreate, rename/replace) and re-resolves; honours
  the `source` filter (no self-trigger); coalesces multi-op writes to one event;
  unsubscribe stops delivery.
- through `synced`: a remote **pull** that rewrites a file fires the watcher and
  invalidates the meta cache (the previously-stale `stat` now reflects the pull).
- re-run `apps/worker`'s suite to confirm the cache-invalidation fix is benign.

**Verify (Phase 2b)**: apps run locally by default; *within-session* offline
works. Then: open paint, ask the agent to draw something → the open window
updates within one sync cycle. (Reload-offline lands in Phase 3.)

### Phase 2c — live agent→client push (collapse the one-sync-cycle lag)

2b delivers the agent's changes correctly but on the **pull cadence**: the agent
writes `/state/<id>.json` on the server replica, and the open window only updates
when the client's next `sync()` pulls it down — up to `syncInterval` (30s,
`synced.ts:37`) later. `volume.watch` is instant; the *pull* it waits on is not.
2c closes that gap by having the server nudge the client to pull immediately,
reusing the **existing `_caps` WebSocket** — no new socket, no new protocol
layer, just a trigger on a channel that already exists.

**Mechanism**
- **Server** (`frieren.app.ts`): the server kernel already emits `app.update` on
  every dispatch, and `ensureSubscribed` (`:140`) subscribes once and fans those
  events to the matching per-app sockets. On the *server* kernel, `app.update`
  fires only for the **agent's own** dispatches (`controller.run`, `actor:'agent'`,
  `:357`) — exactly "the agent changed app X." So in that same handler, also
  send a content-free `{type:'dirty', appId}` to every **caps** socket (tagged
  `serializeAttachment({caps:true})` on accept, `:267`); and call
  `ensureSubscribed()` from the `_caps` accept branch so the subscription is live
  for a tab that only holds the caps socket. ~4 lines; no new dispatch hook.
- **Client** (`capabilities.client.ts`): the `Frame` union already carries
  server-initiated frames, and `onmessage` already ignores frames with no `id`
  (`:96`) — so `{type:'dirty'}` is a clean drop-in. Add a branch that calls the
  synced volume's `flush()` (`synced.ts:301`) → immediate push+pull → the
  agent's write lands in local IDB tagged `REMOTE_SOURCE` → the **2b
  `volume.watch` in `host.ts:270` fires unchanged** → the GUI re-renders. The
  client can flush unconditionally and let the per-file watch route it; `appId` on
  the frame is optional, for future targeting.

**Two gotchas (the only non-trivial parts)**
1. The `_caps` socket is a **lazy singleton**, opened on the first *network*
   capability (`capabilities.client.ts:46`). A volume-only app (paint — the
   canonical "agent draws on the open window" case) never opens it, so the push
   would never arrive. Fix: open the caps socket **eagerly** while any app window
   is open (or at OS boot). One socket per session; cheap.
2. `flush()` lives on the `SyncedVolume` singleton in `fs.ts`, not reachable from
   `capabilities.client.ts` today. Wire it minimally: export a module-level
   `flushActiveVolume()` from `fs.ts` and call it from the dirty branch — keeps
   the caps client decoupled from volume internals.

**Coalescing / offline.** `flush()` already returns the in-flight sync if one is
running (`synced.ts:302`), so a burst of agent writes triggers at most one extra
pull. Offline, dirty frames simply don't arrive and the normal interval /
`online` flush still converges — i.e. it degrades to exactly 2b.

**No `@justfiles/fs` change.** `volume.watch` already exists; 2c is FE + worker
only: ~4 lines in `ensureSubscribed` + a caps-branch `ensureSubscribed()` call
(server); a ~3-line `onmessage` branch + eager open + a one-line `fs.ts` export
(client). It is the lightweight successor to the per-app `state` fan-out: instead
of computing and pushing full state, the server pushes "something changed, pull"
and lets the client's existing sync + watch do the rest, over the one shared
socket. (When the per-app server-kernel path is deleted in Phase 3.5, this dirty
push and the caps socket are what remain of the old `ensureSubscribed` fan-out.)

**Still 100% functional?** Yes — purely additive. If the frame is never sent or
never handled, behaviour is identical to 2b (≤ one sync cycle). No flag needed;
it only has any effect when local apps are on.

**Verify**: open paint (local), ask the agent to draw → the window updates in
~one round-trip + one incremental pull, not after the 30s tick. Offline: the push
doesn't arrive; on reconnect the `online` flush pulls and the window updates. All
of the user's open tabs update.

---

## Phase 3 — PWA + offline boot

Make the **shell** load with no network. App bundles do **not** need the SW —
both halves come from the synced local volume (decided below).

### Bundles load from the local volume (not HTTP)

`app.js` is already read from the volume by the client kernel. **Do the same for
`gui.js`**: read its bytes from `/applications/<id>/gui.js` in the local volume,
`URL.createObjectURL` a module blob, and `import()` that — instead of the HTTP
import in `host.ts:200`. This unifies both bundle halves on the synced volume and
makes a clean consequence:

- **No SW caching of bundles**, and **the token-in-URL problem disappears** (no
  `?token=…` asset fetch at all).
- Offline bundle availability becomes a *volume hydration* concern, not an HTTP
  one. After boot, run a background pass that reads each installed app's
  `app.js`/`gui.js`/icon so `lazyContent` pulls those blobs into IDB — then every
  installed app opens offline. (Don't *execute* apps on boot — hydrate bytes
  only; instantiate the Worker lazily on window open.)

### PWA shell

- Web app manifest + a service worker (e.g. `vite-plugin-pwa`) that caches **only
  the app shell** (Frieren's own build output) — that's all the SW is for now.
- **Offline boot**: ensure Clerk resumes from its cached session; the synced
  volume serves reads from IDB; sync retries (already built-in) when back online.

**Still 100% functional?** Yes online — the SW is additive and the
volume-blob import path is equivalent to the HTTP import when online. Use
versioned caches + disciplined `skipWaiting`/`clientsClaim` so a bad SW can't
wedge loading.

**Verify**: install to home screen; with network off after a warm boot (so blobs
have hydrated), reload and open a never-opened-this-session app → it loads and
works from the volume. Network caps show a clear offline state.

---

## Phase 3.5 — retire the server-kernel FE path (cleanup, after 3 ships)

Through Phases 2b–3 the **server-kernel boot path stays as the rollback lever**:
`shouldUseLocalKernel` defaults on, but `VITE_FRIEREN_LOCAL_APPS=0` flips every
app back to the proven server path with no code change. That reversibility is
load-bearing *until* Phase 3 (PWA + offline boot) is validated in production —
local execution is the thing being de-risked, and Phase 3 still rides on it.

**Once Phase 3 is verified, the dual path is dead weight — delete it.** This is
pure subtraction behind no flag, so it lands as its own PR with the full suite.

**Remove (frontend)**
- `apps/frieren/src/apps/flags.ts` (+ test) and the `localKernel?` /
  `shouldUseLocalKernel?` branching in `os/effects.ts`, `os/store.ts`, `host.ts`
  (`open` always takes the local path).
- `bootRemote` in `host.ts` and its now-unused machinery: the `ServerFrame`
  type, the per-app `/api/apps/<id>/ws` socket, the `outbox`/`pending` dispatch
  plumbing, and the HTTP `gui.js` import (already superseded by the Phase 3
  volume-blob `import`, so `guiUrl`/`guiUrlFor` and the `?token=` asset fetch
  go too).

**Remove (server, `frieren.app.ts`)**
- The per-app dispatch socket and `ensureSubscribed` → WS `state` fan-out
  (already retired *functionally* in 2b — no client opens it — this deletes the
  now-dead code), plus the snapshot-on-connect `state` frame.

**Keep**
- The **server kernel itself** — the agent dispatches through it headless
  (daily alarms / scheduled work), so it never goes away.
- The **`_caps` socket + `invokeCapability`** — still the capability proxy for
  `ai`/`integrations`/`email`/`calendar` from the browser kernel.

**Verify**: standard suite; then `verify:ui` — every app opens, dispatches, and
autosaves with no per-app WS in the network panel (only `_caps` when a network
capability fires); the agent still drives apps headless and its changes reach an
open window via `volume.watch`.

---

## Phase 4 (optional, deferred) — isolation hardening

A Web Worker is **not** a security sandbox (same origin, can `fetch`). If
third-party / untrusted apps become a concern, move the app Worker behind a
**cross-origin sandboxed iframe** (the browser analog of the server's
`globalOutbound: null`). The Phase 2 capability bridge is designed to slot behind
an iframe without touching app code.

**Deferred.** Two reasons: (1) the GUI shares React with the host, so an iframe
boundary means a separate React root/origin and no shared module graph — real
work; (2) the trust model (builtins + self-authored apps) doesn't require it yet.
Start with a Worker; revisit only when untrusted apps land.

---

## Open decisions

1. ~~os-state device-local vs. roam~~ — **resolved: sync everything** (the agent
   depends on os-state server-side; single-writer keeps it conflict-free).
2. ~~Worker vs. iframe~~ — **resolved: Worker** (GUI shares React with the host,
   making iframe costly; trust model doesn't require it). Iframe deferred to
   Phase 4.
3. ~~Agent→open-app live updates~~ — **resolved: add `volume.watch(path, fn)`**,
   an inotify-style primitive driven by a Storage-level change feed (detection
   must be below the volume, since sync pulls bypass the volume wrapper). Host
   watches each open app's state file (and open documents) and pushes fresh
   state via the existing GUI channel. Generalizes to documents; accepts a
   one-sync-cycle delay — collapsed to ~instant by the Phase 2c dirty-push.
4. ~~Bundle offline mechanism~~ — **resolved: load `gui.js` from the local volume**
   (blob-URL `import`), same as `app.js`. SW caches the shell only; the
   token-in-URL problem disappears; offline bundles become a volume-hydration
   concern.
5. ~~Server change-monitoring~~ — **resolved: none needed.** The kernel is
   stateless between dispatches, so the server reads current state on demand; its
   WS state-push (`ensureSubscribed`) is retired for client-side apps. The WS
   becomes a **capability proxy** (new capability-invoke frame; server
   re-authorizes scopes from the installed manifest) — and, in Phase 2c, also
   carries a content-free `dirty` push so the client pulls the agent's changes
   immediately instead of waiting for the next interval.

## Per-phase verification (every phase)

```sh
pnpm format && pnpm typecheck && pnpm lint:fix && pnpm test
# then, for UI-affecting phases:
cd apps/frieren && pnpm run dev   # and, in another shell:
pnpm run verify:ui                # LLM-driven smoke check
```
