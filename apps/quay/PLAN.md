# quay — implementation plan

A native macOS shell (`apps/quay`) where each `@justfiles/app-*` mini-app is its own `.app` bundle
rendering in a `WKWebView`, all docking at one shared Node daemon (`quayd`). See `DESIGN.md`.

> Ground rules (`CLAUDE.md`): keep code minimal; tab indentation; minimum dependencies; compose
> existing packages. After each slice that touches JS/TS:
> `pnpm format && pnpm typecheck && pnpm lint:fix && pnpm test`. Native parts build with `swiftc` via a
> per-slice `build.sh` (Command Line Tools only — no full Xcode).

## Reuse — already in the monorepo

Nothing here is built from scratch; `quay` is a new **host** over existing packages:
`@justfiles/app` (kernel, `reactGui`, `volumeCapability`, `reconcileBuiltins`, devkit; depends on
`capnweb`), `@justfiles/agent`, `@justfiles/fs` (`volume`, `nativeStorage`), and every `@justfiles/app-*`
bundle. The WKWebView `.app` shape is already proven in `apps/desktop/native-poc`.

## Where apps live (the one architectural decision)

Apps live in the **Volume's `/applications`** — the canonical, syncable store the kernel already owns,
unchanged from frieren. Each `~/Applications/Quay Apps/<App>.app` is a **thin, code-less projection** of
that catalog, materialised **one-way** (Volume → OS) for macOS identity (Dock/Spotlight/Cmd-Tab). The
`.app` is never a second source of truth and never syncs; `quayd` serves the actual `gui.js`/`app.js` from
the Volume over http. Keeping the bytes in the Volume is what lets a later swap to frieren's synced backend
sync the whole catalog for free — and keeps the portable core identical across web and native. (Making the
`.app` itself the store is faithful to "real apps" but is incompatible with whole-Volume sync, so it's out.)
See `DESIGN.md` §1/§5.

## Module layout

```
apps/quay/
  quayd/          # Node daemon: kernel + Volume + sandbox + caps + agent + http/ws + .app materialisation
  native/         # one Swift program, two modes: the booter + the launcher (+ build.sh)
  launcher-ui/    # launcher web UI (mocked first; later served by quayd)
  DESIGN.md · PLAN.md
```

## The milestones you can watch for

**End of Slice 3 (mocked):** open the launcher, see a list including **Code**, click it, and a `WKWebView`
window titled "Code" opens with its own Dock icon — *before any backend exists*. Proves the native-shell idea.

**End of Slice 6 (real):** the same apps are now **real macOS apps** — seeded from the kernel's catalog and
indexed by Spotlight / Launchpad / Raycast, launchable even with the launcher closed. **End of Slice 7:**
launching one renders its actual `gui.js`.

---

# Phase 0 — native shell, mocked (no JS backend yet)

Pure Swift + mocked data. Fast, visible progress; zero dependency on the kernel.

## Slice 1 — the booter

**Goal:** generalise the POC into a reusable booter that opens a `WKWebView` at a configurable target.
One compiled binary; the app id + URL come from the bundle's `Info.plist` (`QuayAppId`) or an env/arg
override for dev.

**Touches:** `apps/quay/native/Booter.swift`, `apps/quay/native/build.sh`.

**Build & verify:**
```sh
cd apps/quay/native && ./build.sh Code        # emits "Code.app" pointing at a mock URL/html
open ./Code.app
```
A window titled "Code" opens rendering a placeholder page (its own Dock icon, blue mock content).
`otool -L Code.app/Contents/MacOS/* | grep WebKit` confirms system WebKit; bundle is tens of KB.

## Slice 2 — the launcher panel + global hotkey

**Goal:** `Quay.app` — an `LSUIElement` agent (no Dock icon) whose global hotkey toggles a frameless,
vibrancy-blurred `WKWebView` panel showing a **mocked** app list (incl. "Code", "Finder", "Paint").

**Touches:** `apps/quay/native/Launcher.swift` (mode of the same binary), `apps/quay/launcher-ui/`
(static HTML/JS list, no backend), `build.sh`.

**Build & verify:**
```sh
cd apps/quay/native && ./build.sh --launcher   # emits "Quay.app"
open ./Quay.app                                 # no Dock icon appears (LSUIElement)
```
Press `Option+Space` → translucent panel appears centred, listing the mocked apps; press again → hides.
*(Hotkey check is manual — synthetic events don't reach Carbon global shortcuts; press it yourself.)*

## Slice 3 — launch a mini-app from the launcher  ⟵ **the idea, verified**

**Goal:** clicking an item in the launcher opens that app's `.app` bundle as its own window/identity
(mocked content), via LaunchServices — not as a launcher window.

**Touches:** `launcher-ui/` (click → `window.quay.open(id)`), the launcher's native bridge
(`WKScriptMessageHandler` → `NSWorkspace.open(<id>.app)`), a tiny generator that stamps a `.app` per
mocked id into a dev folder.

**Verify:** `Option+Space` → click **Code** → a `WKWebView` window titled "Code" opens with its own
Dock icon. Close it; the launcher and other windows keep running. `Cmd+Q` on an app quits only it.

---

# Phase 1 — the daemon & the real catalog

Introduce `quayd`; move the catalog from mocked HTML to the kernel; project it into the real OS.

## Slice 4 — `quayd` skeleton + discovery + ensure-running

**Goal:** a Node daemon that listens on `127.0.0.1`, writes `runtime.json` ({port, token, pid}), and a
client handshake: the launcher reads `runtime.json`, spawns `quayd` if absent, then connects over ws.
The launcher's app list now arrives **over the socket** (a stub catalog served by `quayd`), not from
hardcoded HTML.

**Touches:** `apps/quay/quayd/{main,server,discovery}.ts`, launcher native (spawn + read runtime.json),
`launcher-ui/` (fetch list over ws).

**Verify:**
```sh
cd apps/quay && pnpm quayd                  # logs port; writes ~/Library/Application Support/quay/runtime.json
```
Open `Quay.app`; the list renders from `quayd` (kill `quayd` → launcher shows "connecting"; relaunch via
the launcher re-spawns it). `pnpm typecheck && pnpm test` green.

## Slice 5 — Volume + kernel + seed built-ins

**Goal:** `quayd` mounts `volume(nativeStorage(...))`, instantiates the kernel with a **stub** capability
seam, and seeds built-ins via `reconcileBuiltins` over packaged bundles — **app-code (Code) +
app-finder (Finder)**. The launcher lists the real `kernel.list()`.

The Volume's `/applications` is the **canonical, syncable** store — apps live *here*, not in the `.app`s
(Slice 6 projects them into the OS). Keeping them in the Volume is what lets a later swap to frieren's
synced backend sync the catalog for free. **No kernel change** — `quay` reuses the existing Volume store.

> Runtime note: `@justfiles/app`/`@justfiles/fs` ship TS source with extensionless internal imports, so
> quayd runs through the `tsx` loader (`node --import tsx`, wired into `pnpm quayd` and the launcher's
> spawn) rather than bare `node`.

**Touches:** `quayd/{main,host,builtins}.ts` (volume + kernel + seed), `package.json` (workspace deps +
`tsx`), `native/Launcher.swift` (spawn via the tsx loader).

**Verify:** `~/Library/Application Support/quay/volume/applications/<app-code id>/` exists on disk
(open in Finder); the launcher shows the real built-in catalog including **Code** and **Finder**. A debug
`kernel:ls` over ws returns a real directory listing.

## Slice 6 — project the catalog into the OS (`.app` materialisation + Spotlight)  ⟵ **real apps in macOS**

**Goal:** `quayd` materialises a **thin** signed `.app` per installed app into `~/Applications/Quay Apps/`
— shared booter binary + per-app `Info.plist` + icon, **no app code** (the bytes stay in the Volume) —
`codesign -s -`, `lsregister`, reconciled **one-way** to `kernel.list()` (install/sync-in → write; uninstall
→ remove; update → refresh icon/name). This replaces the Phase-0 dev-script mock `.app`s with real,
kernel-driven ones. Because the reconcile is one-directional, there's no two-store coherence problem — the
Volume always wins.

**Touches:** `quayd/materialize.ts` (write/sign/register/reconcile `.app`s), booter-binary packaging (where
`quayd` finds the shared booter), `quayd/main.ts` (run reconcile on boot + on catalog change).

**Verify:** built-ins appear in **Spotlight / Launchpad / Raycast** (`Cmd+Space` → "Code"). Launching
**Code from Spotlight** with the launcher closed ensure-runs `quayd` and opens its window. (The window is a
placeholder until Slice 7 wires real rendering.) Removing an app from the kernel removes its `.app`.

---

# Phase 2 — real app rendering

Render real `gui.js` and round-trip a dispatch.

## Slice 7 — assets + Cap'n Web berths

**Goal:** `quayd` serves `gui.js` + the shared-React importmap over localhost http; the booter loads
`http://127.0.0.1:PORT/app/<id>?token=…`; a token-scoped **berth** (Cap'n Web) provides
`dispatch`/`subscribe`/`state`; `reactGui` mounts the real GUI. `quayd` reads the bytes **from the Volume** —
the materialised `.app`s carry none.

**Touches:** `quayd/server.ts` (http assets + importmap injection + Cap'n Web berth), booter (load URL +
token), `reactGui` Transport shim.

**Verify:** launching **Code** (or Counter) renders its **real** `gui.js`; an action round-trips
(`berth.dispatch` → kernel → `app.update` → `subscribe` re-render) and state persists to
`/state/<id>.json`. Token from another origin is rejected.

## Slice 8 — `nodeSandbox` lazy eviction

**Goal:** the `worker_threads` sandbox (shared protocol, content-addressed, lazy on first dispatch)
already landed in Slice 7 — the berth round-trip needs a running reducer. Slice 8 adds the eviction
policy on top: tear a worker down after its app's window closes + an idle window, re-spawn on demand.

**Touches:** `quayd/nodeSandbox.ts`, kernel wiring, eviction policy.

**Verify:** a reducer runs off the main thread (state changes persist); after the idle window with no
open app window, the worker is gone (`ps`/log); next dispatch re-spawns it transparently. Sandbox tests
green.

---

# Phase 3 — capabilities, agent, install

## Slice 9 — capabilities in-process

**Goal:** replace the stub seam with `capabilityRegistry({ volume: volumeCapability(fs, {systemAllowlist}) })`
(+ `ai` if a key is present). An app that uses `volume` works against real files.

**Verify:** Finder/Paint (volume users) read/write real files under `/data/<id>`; edits show up in
Finder.app on disk. Capability/scope tests green.

## Slice 10 — agent in `quayd` + agent UI in the launcher

**Goal:** instantiate `@justfiles/agent` with a `quay` `AppController` (open/close real bundles) + a
Cap'n Web `SocketLike`; mount the agent chat in the launcher.

**Verify:** the agent can `app list/launch/run`, edit memory, and an open **Code** window updates live
when the agent dispatches to it. Agent/session tests green.

## Slice 11 — app-code build & install via devkit

**Goal:** thin desktop devkit over `@justfiles/app/devkit` — native-esbuild toolchain; `installDraft`
writes `/applications`, fires `onInstalled` → `.app` materialised (Slice 6's reconcile) → launcher +
Spotlight re-list. `packDraft` for export.

**Verify:** author a tiny project in **Code**, click Install → it appears in the launcher **and**
Spotlight, launchable as its own app — with no code change to app-code's reducer.

---

# Phase 4 — later / deferred

| Item | Note |
|----|----|
| **Hardening** | enforce token scoping, WKWebView CSP/navigation lockdown, `quayd` single-writer lock, idle-exit policy, booter reconnect-on-drop. Fold critical bits into earlier slices. |
| **Sync backend** | swap `nativeStorage` for frieren's synced Volume backend — apps/state/data then sync across devices with no change to where apps live; the `.app` projection regenerates per device. |
| **Projection drift** | watch `~/Applications/Quay Apps/` so a Trash-ed `.app` becomes a real uninstall (the one tolerated `.app` → Volume edge). v1 just re-materialises on next reconcile. |
| **Live preview** (`devkit.run`) | the one bespoke seam — a second `WKWebView` over the code window's slot. |
| **Multi-window** per app | `open -n` / in-shell windows, all live-syncing one kernel state. |
| **Native-touching caps** | notifications, clipboard, reveal-in-Finder via a small native helper. |
| **Signing / notarisation** | needs `notarytool` (full Xcode); only for public distribution. |
| **Cross-platform** | Windows via wry/Tauri + WebView2 — see `apps/desktop/DESIGN.md` research. |

## Decisions (resolved)

- **App home:** apps live in the Volume's `/applications` (canonical, syncable); each
  `~/Applications/Quay Apps/<App>.app` is a thin, code-less **projection** materialised one-way from the
  kernel — not a second store. Keeps the catalog syncable via a later Volume-backend swap and the portable
  core unchanged; the rejected alternative (the `.app` *is* the store) can't sync the whole Volume.
- **Hotkey:** `Option+Space` (avoids Spotlight's `Cmd+Space`).
- **Bundle ids:** `app.justfiles.quay` (launcher); `app.justfiles.quay.app.<id>` (each mini-app).
- **Built-in seed set (v1):** `app-code` (Code) + `app-finder` (Finder) + `app-counter` (Counter) —
  Counter is a no-capability app, so it's the clean end-to-end target for the Slice 7 berth round-trip
  before capabilities land (Slice 9).
- **`apps/native/`:** removed (was empty scaffolding).
