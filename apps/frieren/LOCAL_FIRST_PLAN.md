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

Apps stay **files in the volume** at `/applications/<id>/`; `/state` and `/data`
are volume-backed too. Size and distribution are handled *below* the volume by its
own blob layer (content-addressed blobs, `lazyContent` hydration, R2 on the
server / IDB in the browser) — not by a separate app-asset cache. Built-ins are
seeded from static assets (Phase 4c); the future app store
([`APP_STORE_PLAN.md`](APP_STORE_PLAN.md)) is only a discovery layer on top.

### Why two kernels is safe (no logic duplication)

App logic is **not** compiled into either kernel runtime. Both kernels load app
bytes by reading `/applications/<id>/app.js` (and `gui.js`) from the volume — the
same files, synced between them, so they cannot diverge except by transient sync
lag, which self-heals on the next pull. The volume's blob layer keeps the bytes
content-addressed and hydrates them lazily where needed.

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

- **Browser kernel** runs `app.js` in a Web Worker against the local profile
  volume; executes the user's actions, offline-capable.
- **Server kernel stays** and executes the agent's actions headless when a
  backend session exists.
- **Local profile volume = working copy.** The browser-local IDB volume is the
  source of truth for local execution. The backend is an optional replica, not a
  boot prerequisite.
- **`synced()` is local-first.** It returns a usable local volume immediately;
  sync starts/continues in the background when auth + network + remote storage
  are available. `flush()` is a replication request, not part of opening the OS.
- **Apps are files in the volume.** `/applications/<id>/` holds the app's files
  (`app.js`, `gui.js`, manifest, icon). Install = write files; uninstall = delete
  them. Size/distribution are handled below the volume by its blob layer
  (content-addressed, `lazyContent`, R2/IDB), not by a separate asset cache.
- **Built-ins are seeded, not bundled.** The OS ships built-in app bytes as static
  Assets and seeds them into a new profile's volume on boot (Phase 4c), instead of
  embedding byte modules in the Worker script. A version-aware boot reconcile picks
  up updates and honors uninstall (disabled) markers.
- **Capabilities split** (see table below): `volume` is local in the browser;
  backend-backed capabilities proxy to the server and are unavailable when
  offline or unauthenticated.
- **PWA**: service worker caches the shell (and precaches built-in app assets so
  new profiles can seed them offline). App files live in the volume (IDB), so the
  OS and installed apps boot offline once their bytes are resident.

### App storage model

Apps are files in the volume; there is no separate package/asset layer. The
volume's blob layer already provides what a content-addressed app store would
(dedup by hash, lazy hydration, R2 on the server / IDB in the browser), so install
is just file I/O. Built-ins are seeded from static assets (Phase 4c); installing a
local zip writes its files in (Phase 4f). A backend **app store** — browsing a
catalog and installing remote apps — is a deferred discovery layer on top,
specified in [`APP_STORE_PLAN.md`](APP_STORE_PLAN.md). It is not required for
local-first and blocks nothing here.

### Capability split

| Capability           | Browser kernel                         | Offline / signed out                       |
|----------------------|----------------------------------------|--------------------------------------------|
| `volume`             | local profile volume (chroot per scope) | ✅ works                                   |
| `ai`                 | proxy → server over WS                 | ❌ rejects `CAPABILITY_OFFLINE` / unauth   |
| `integrations`       | proxy → server over WS                 | ❌ rejects                                 |
| `email` / `calendar` | proxy → server over WS                 | ❌ rejects                                 |

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
  previous user's local volume must never leak into the next. This was the safe
  transitional policy; Phase 4 replaces it with preserved local profiles plus an
  explicit "forget this browser" action.
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
  (server-served for now; served from local volume bytes from Phase 3 on).

> **Cold start**: the client kernel runs an app only once its executable bytes are
> available locally. Those bytes live in the volume and hydrate on first read
> (`lazyContent`). Phase 4c seeds built-ins from static assets so they're available
> without a server-side install first.

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

Make the **shell** load with no network. App byte availability is a hydration
problem: after an app is installed, its executable assets must be cached locally
before it can open offline.

### App asset availability

The Phase 3 bridge loads both executable halves from local bytes in the volume:

- `app.js` is read by the browser kernel;
- `gui.js` is read by the host, turned into a blob URL, and `import()`ed.

Both live as files in `/applications/<id>/`. This shape is unchanged by the app
store — installing only ever *writes those files*; loading always reads them.

Consequences:

- **No token-in-URL dynamic imports.** GUI modules load from local volume bytes.
- **No Worker bundle bloat.** Built-in app bytes are static Assets seeded into the
  volume (Phase 4c), not imports embedded in `worker/index.ts`.
- **Offline launch requires resident bytes.** An app opens offline once its files
  are resident in the local volume (seeded for built-ins; hydrated on first online
  launch for synced user apps). Instantiate workers lazily on window open, not on
  boot.

### PWA shell

- Web app manifest + a service worker (e.g. `vite-plugin-pwa`) that caches **only
  the app shell** (Frieren's own build output) and can cache immutable public app
  asset responses opportunistically.
- **Offline boot**: the local profile volume serves reads from IDB. Sync retries
  when auth/network return; Phase 4 removes auth as a render gate entirely.
  - **Scope caveat — Phase 3 assumes a warm Clerk session.** Boot still goes
    through `ClerkProvider`, and `@clerk/clerk-react` fetches `clerk-js` at
    runtime from Clerk's frontend API (cross-origin, dynamic URL) — the
    same-origin SW *cannot* precache it. So Phase 3 offline boot only survives if
    `clerk-js` is already in the browser HTTP cache and Clerk resumes its cached
    session. A cold cache (or signed-out user) still wedges at the auth gate.
    Decoupling boot from auth entirely is **Phase 4**, below.

**Still 100% functional?** Yes online — the SW is additive and the local-byte
import path is equivalent to the HTTP import when online. Use versioned caches +
disciplined `skipWaiting`/`clientsClaim` so a bad SW can't wedge loading.

**Verify**: install to home screen; with network off after a warm boot (so app
assets have hydrated), reload and open a never-opened-this-session app → it loads
and works from local cached bytes. Network caps show a clear offline state.

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

## Phase 4 — Auth-optional offline boot (the OS boots signed-out)

The end state of local-first: **the OS, the shell, and every local app boot with
no auth at all.** Auth stops being a precondition for *running* Frieren and
becomes purely a **gate on backend-backed capabilities** — sync, the agent (AI),
email, calendar, integrations. Signed-out (or signed-in but offline), you still
boot the desktop, open paint, install/uninstall apps locally, and work in the
local profile volume.

**Why this lands after Phase 3.5.** Auth-optional boot rests on one premise: the
local kernel is the only FE app execution path, and it needs no token. Phase 3.5
establishes that by deleting `bootRemote`. After that, the only token-bearing
paths are sync, the agent socket, app-store private/paid fetches, and the `_caps`
network-capability proxy — exactly the things we want to gate.

### Phase 4a — make `synced()` truly local-first

`@justfiles/fs` `synced()` should behave like a local filesystem with optional
replication:

- return the local `Volume` immediately after opening local storage;
- start bootstrap/push/pull in the background when `remote` is available;
- allow `remote` to be absent or lazily supplied after auth exists;
- expose sync/backend status (`local-only`, `unauthenticated`, `offline`,
  `connecting`, `syncing`, `synced`, `error`);
- make `flush()` request push+pull without making OS boot depend on success.

This is the natural `synced` contract: local is the working copy; remote is a
replica.

#### Adoption: server authoritative, but never silently destroy local work

For an authed user the **server is the authority** for the synced namespace — the
remote owns inos, and steady-state sync stays as-is (remote-authoritative pull
with the existing mtime last-writer-wins tiebreak, `synced.ts:142`). We do **not**
build a bidirectional merge.

The one hazard is *adoption*: today `sync()` runs `bootstrap()` whenever
`remoteCursor === undefined` (a never-synced profile's state on first sync), and
`bootstrap()` → `reconcileLocal()` (`synced.ts:196`) **deletes every local-only
file absent from the remote snapshot**. So never point the default local profile
at an account remote. Account profiles are separate; explicit import can copy
local files into them later.

Keep it simple now; improve later:

1. **Never destructively bootstrap a dirty profile.** Adoption opens/creates the
   user's *own* profile volume and bootstraps **that**, leaving the existing
   profile's IDB intact and separately openable (the Phase 4b per-profile model
   makes this free). Concretely in `@justfiles/fs`: `reconcileLocal`'s
   unconditional delete must not run against a profile that still has un-pushed
   local-only inodes — gate it, or simply never point a dirty profile's volume at
   a non-empty remote.
2. **Warn + offer a backup** if the default local profile has work during
   sign-in: "Signing in switches to your account's data; N local files here won't
   be uploaded. [Download backup] [Continue]." This lives in the profile UI, not
   in `synced.ts`.

Deferred (not now): an opt-in *"import my local files into this account"* that
re-writes local files by path+content as new creates (fresh UUID inos → pushed
normally), with a per-path conflict policy (skip / overwrite / keep-both). Cheap
to add later because inos are UUIDs; out of scope for the first cut.

### Phase 4b — local profiles, not auth users, own local storage

Create a local profile registry, separate from Clerk:

```ts
type LocalProfile = {
  id: string
  remoteUserId?: string
  name?: string
  lastOpenedAt: number
}
```

Use DB names like `frieren-fs-profile-<localProfileId>`, not
`frieren-fs-<clerkUserId>`. The **registry itself** is browser-global (one
small IDB or `localStorage` key), separate from any profile volume, since it
must be read before a profile volume is opened. Boot policy:

1. open the browser's default local profile (`local`), reusing an existing
   anonymous profile if one exists;
2. render the desktop immediately;
3. start auth/sync as a side-effect if Clerk/session information is available.

Sign-in switches to the profile owned by that account (creating it if needed) and
starts sync. The default local profile is not silently adopted into the account;
import/merge is explicit later. Sign-out stops sync/backend sockets and switches
back to the default local profile, but **does not delete account-local data**. A
separate explicit action (`Forget this profile from this browser`) deletes an
IDB/profile. This is the right default for offline-capable local software. It can
show private data to another person using the same browser profile, so add a
visible profile switcher / forget action; stronger privacy (passcode/encryption)
is a later hardening step.

When a user signs in, adoption follows the Phase 4a rules (server authoritative,
never destructively bootstrap a dirty profile):

- if that remote user **already has a local profile** on this browser → switch to
  it; do not auto-merge (open decision #7);
- else create a new account profile for that remote user and sync it;
- if the default local profile has work the user wants in the account, offer an
  explicit backup/import flow instead of auto-merging.

### Phase 4c — seed built-in apps from static assets

Built-ins ship as **static assets**, not Worker-bundled byte modules, and are
seeded into each profile's volume as plain files. This is what lets a local (even
signed-out, offline-after-first-load) profile launch built-ins with no backend.

Today built-ins are imported as `@justfiles/app-*/bundle` byte modules into
**both** the Worker bundle (`worker/builtins/index.ts` → `frieren.app.ts`
`installBuiltins`) **and** the client (`worker/index.ts`). 4c removes both imports
and replaces them with static assets + a manifest fetched over HTTP.

#### URL scheme (shared with the future app store)

Pick the namespace so built-in bytes are served **statically and publicly** today
and the *same routes* host the dynamic store later. `wrangler.jsonc` runs the
Worker first only for `["/api/*", "/fs/*", "/ws"]`; everything else falls through
to the `ASSETS` binding. So put the app-store space at **`/appstore/*`** (not
`/api/appstore`) — built-ins serve straight from `ASSETS`, no Worker, no auth, and
the PWA can precache them.

```txt
GET /appstore/catalog.json                       the catalog
GET /appstore/apps/<id>/<version>/<path>         an app file (app.js, gui.js, icon, manifest.json)
```

`catalog.json` is the one piece of "catalog" the OS needs now:

```json
{
  "schema": "frieren/appstore-catalog/v1",
  "apps": [
    {
      "id": "app.frieren.paint", "name": "Paint", "version": "0.1.0",
      "icon": "icon.svg",
      "files": [
        { "path": "app.js", "hash": "sha256-…", "size": 12843 },
        { "path": "gui.js", "hash": "sha256-…", "size": 30187 },
        { "path": "manifest.json", "hash": "sha256-…", "size": 412 },
        { "path": "icon.svg", "hash": "sha256-…", "size": 1180 }
      ]
    }
  ]
}
```

Bytes live at version-pathed URLs (`/appstore/apps/app.frieren.paint/0.1.0/app.js`)
so a release is immutable and permanently cacheable; `hash` is for integrity on
seed and for the volume's dedup. Later the store adds `category`/`description` to
each entry and serves third-party apps from R2 through the Worker at the **same**
`/appstore/apps/<id>/<version>/<path>` shape (add those paths to
`run_worker_first` when that lands); built-ins keep serving from `ASSETS`.

#### Build/deploy

A small build step (Vite plugin or `tsc`-run script invoked from `build`) instead
of the `@justfiles/app-*/bundle` worker imports:

- for each built-in package, copy its `dist/bundle` files (`app.js`, `gui.js`,
  `manifest.json`, icon) into `dist/client/appstore/apps/<id>/<version>/`;
- hash each file and emit `dist/client/appstore/catalog.json`.

Because these land in `dist/client`, the `ASSETS` binding serves them and the
build is **atomic by construction** — the catalog and the bytes it references ship
in the same deploy.

**PWA precache.** App files are `.js`/`.svg` (already covered by the Workbox
`globPatterns`); add `appstore/**/*.json` so `catalog.json` and per-app
`manifest.json` precache too. After that, a warm browser can seed a *new* profile
fully offline.

#### Boot reconcile (every boot, version-aware)

1. fetch `/appstore/catalog.json` (served from the SW cache when offline);
2. for each app, read the installed version from
   `/applications/<id>/manifest.json` (absent ⇒ not installed);
3. **seed** if missing, **overwrite** if the catalog version is newer, **skip** if
   equal — fetch each file, verify `hash`, write into a temp dir, then
   `atomicMove` into `/applications/<id>/` so a half-written app never launches;
4. **honor uninstall markers** — "uninstalling" a built-in writes
   `/system/apps/disabled/<id>.json`; reconcile must not re-seed a disabled app on
   a version bump.

#### Synced profiles (server parity, deferrable)

The same end state without a separate path: the client seeds locally and sync
replicates the files up to R2; other devices pull them (lazy, hydrate on launch).
The Durable Object can run the identical reconcile by fetching the same assets
through its `ASSETS` binding (`env.ASSETS.fetch('/appstore/...')`) — no
worker-bundled bytes. Guard against two fresh devices double-seeding before the
first sync (seed only after first sync settles, or let the server be the sole
materializer for synced profiles) — deferrable until sync'd seeding is built.

### Phase 4d — boot shell independent of Clerk

`ClerkProvider` / auth state becomes optional infrastructure, not the root render
gate. The OS can check auth every load, but it only updates backend status:

```ts
type BackendState =
  | 'local-only'
  | 'unauthenticated'
  | 'offline'
  | 'connecting'
  | 'connected'
  | 'error'
```

Menu bar can show this state (`Local only`, `Signed out`, `Connecting…`,
`Synced`, `Offline`). The agent panel and network capabilities read this state;
the desktop and local apps do not block on it.

`clerk-js` offline becomes non-load-bearing: sign-in still needs network, but
booting the OS and running local apps does not.

### Phase 4e — move onboarding to opt-in setup (defered)

NOTE: this is defered to after we redesign the agent UI. don't worry about this

First anonymous visit should load the desktop immediately. Onboarding is no
longer a boot step. It runs when the user chooses one of these flows:

- set up / enable the AI agent;
- create or connect an account;
- personalize the local profile.

The agent panel should show a clear setup state (`Sign in and set up your agent
to enable AI`) instead of erroring. Onboarding writes profile/soul files to the
local profile volume; if a backend is connected, flush them before enabling the
server agent.

### Phase 4f — install/uninstall apps offline

App management is plain local-volume file work — no records, no separate asset
cache:

- **local zip install**: unpack the zip and write its files into
  `/applications/<id>/` (stage + atomic rename); it runs on this browser
  immediately, fully offline.
- **uninstall**: close the app, then delete `/applications/<id>/` (and its
  `/state`/`/data` for user apps); built-ins instead get a disabled marker so the
  Phase 4c reconcile doesn't re-seed them.
- **sync** later replicates the app files / state / data when a backend exists,
  like any other volume content.

A synced user app can reach a second device whose volume hasn't hydrated its bytes
yet; it is "installed" there but **needs one online launch on that device** before
it runs offline. This is the general lazy-file property, not an app-specific case —
surface it as a launch state, not an error.

Installing from a remote **app store** (browse a catalog, download an app's files)
is the same file-write, sourced from a catalog instead of a zip — deferred to
[`APP_STORE_PLAN.md`](APP_STORE_PLAN.md). The existing server `/api/apps/install` /
uninstall endpoints can become legacy or app-store admin paths; they are not
required for normal local app management.

**Still 100% functional?** Yes online/signed-in — this adds local profile boot,
keeps sync as a backend capability, and keeps the server kernel for agent work.

**Verify**: with no Clerk session and network off, cold-boot the installed PWA →
desktop loads, built-in paint opens and draws, and a local zip app can install
and uninstall. Then sign in online → backend status becomes connected, sync
starts, agent setup is opt-in, and existing local work remains.

---

## Phase 5 (required before public third-party apps) — isolation hardening

A Web Worker is **not** a security sandbox (same origin, can `fetch`). A real app
store with third-party authors changes the trust model: GUI code imported into
the host page can access the host origin and DOM. Before allowing untrusted public
apps, move app execution/GUI behind a cross-origin sandboxed iframe (the browser
analog of the server's `globalOutbound: null`) or another equivalent isolation
boundary.

The Phase 2 capability bridge is designed to slot behind an iframe without
changing app logic. Until Phase 5 lands, the app store should be limited to
built-ins, trusted/reviewed apps, or self-installed local zips.

---

## Open decisions

1. ~~os-state device-local vs. roam~~ — **resolved: sync everything** (the agent
   depends on os-state server-side; single-writer keeps it conflict-free).
2. ~~Worker vs. iframe for trusted/local apps~~ — **resolved: Worker for now.**
   Phase 5 iframe/cross-origin isolation is required before public untrusted
   third-party apps.
3. ~~Agent→open-app live updates~~ — **resolved: add `volume.watch(path, fn)`**,
   an inotify-style primitive driven by a Storage-level change feed (detection
   must be below the volume, since sync pulls bypass the volume wrapper). Host
   watches each open app's state file (and open documents) and pushes fresh
   state via the existing GUI channel. Generalizes to documents; accepts a
   one-sync-cycle delay — collapsed to ~instant by the Phase 2c dirty-push.
4. ~~Bundle offline mechanism~~ — **resolved: apps stay files in the volume.** No
   install records or separate asset cache; the volume's own blob layer
   (content-addressed, `lazyContent`, R2/IDB) handles size and distribution below
   the file abstraction. Built-ins are seeded from static assets (Phase 4c); a
   backend app store is a deferred discovery layer
   ([`APP_STORE_PLAN.md`](APP_STORE_PLAN.md)).
5. ~~Server change-monitoring~~ — **resolved: none needed.** The kernel is
   stateless between dispatches, so the server reads current state on demand; its
   WS state-push (`ensureSubscribed`) is retired for client-side apps. The WS
   becomes a **capability proxy** (new capability-invoke frame; server
   re-authorizes scopes from the installed manifest) — and, in Phase 2c, also
   carries a content-free `dirty` push so the client pulls the agent's changes
   immediately instead of waiting for the next interval.
6. ~~Anon→authed volume handoff~~ — **resolved direction: local profiles are
   first-class and preserved.** Signed-out boot opens the browser's default local
   profile. Sign-in switches to that account's sibling profile and starts sync;
   sign-out switches back to the default local profile. No automatic merge/import;
   deleting local data requires an explicit "forget this browser" action.
7. **Precise merge UX (open, Phase 4).** The storage direction is clear
   (server-authoritative adoption, local profile preserved — Phase 4a), but the
   user-facing choice when both current-local and existing-remote/local-profile
   data exist still needs product copy and conflict UX. **Safe default: do not
   auto-merge.**
   If signing in as user X while another local profile already maps to X, switch
   to the existing profile and keep the just-used one as an orphan — auto-merging
   creates two local replicas of one remote and cross-pollinates them on sync.
   Merge stays an explicit, opt-in action.
8. **App-store trust boundary (open before public launch).** Installing apps as
   files supports third-party apps, but public untrusted apps require Phase 5
   isolation **and** a review/signing/trust policy for catalog bytes. Tracked in
   [`APP_STORE_PLAN.md`](APP_STORE_PLAN.md) *Trust*.

## Per-phase verification (every phase)

```sh
pnpm format && pnpm typecheck && pnpm lint:fix && pnpm test
# then, for UI-affecting phases:
cd apps/frieren && pnpm run dev   # and, in another shell:
pnpm run verify:ui                # LLM-driven smoke check
```
