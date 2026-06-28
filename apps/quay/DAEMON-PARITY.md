# daemon parity with quayd

`apps/quay/daemon/` is not yet at feature parity with `apps/quay/quayd/`. It has a partial Bun-native host, but it is not a drop-in replacement for the native Quay app yet.

## Missing before switching the app to daemon

- [x] **Discovery/runtime file**
	- Write `~/Library/Application Support/quay/runtime.json` with `{ port, token, pid }`.
	- Clear it on daemon exit.
	- Match the native Swift `Quayd.ensure()` discovery path.

- [x] **Native protocol compatibility**
	- Chose: update the Swift launcher to the daemon's `/system` + `/agent` protocol
	  (rather than re-emulate quayd's legacy `/?token` JSON channel on the daemon).
	- Catalog: `CatalogClient` now opens `ws://127.0.0.1:<port>/system` and decodes the
	  pushed `{ type: "apps", apps }` frame (no `list`/`commands` request). `CatalogApp`
	  decodes `AppManifest` down to `{ id, name }` and derives the fallback glyph.
	- Chat: added a daemon `/launcher/chat` surface (`daemon/launcher/chat.tsx` + `.html`)
	  that renders the shared `<Transcript/>` over the daemon's `/agent` Cap'n Web RPC and
	  exposes the `window.quaySend/quayCommand/quayAbort` + `webkit.messageHandlers.status`
	  native bridge. The Swift webview path (`/launcher/chat`) is unchanged.
	- Deferred to their own items (native already wired, daemon side pending): slash
	  `commands`/`command` + `abort`, `notification` pushes, post-install catalog
	  re-broadcast, and token enforcement.

- [x] **`.app` projection** (`daemon/materialize.ts`, wired in `daemon/main.ts`)
	- [x] Materialize installed apps into `~/Applications/Quay Apps/*.app` — shared booter
	  binary + per-app `Info.plist` + generated icon, no app code (bytes stay in the Volume,
	  served over http). Preview apps (`preview.*`) are filtered out.
	- [x] Stamp `Info.plist`, app id, icon, and daemon spawn keys — `QuaydRuntime` is the
	  absolute daemon path (shipped `quay-daemon`, dev bun on `daemon/main.ts`); `QuaydScript`
	  and `QuaydArgs` are empty when shipped, so a cold-launched bundle respawns the daemon.
	- [x] Ad-hoc sign (`codesign -s -`) and register bundles with LaunchServices (`lsregister`).
	- [x] Reconcile one-way from kernel catalog to OS projection — Volume wins; idempotent via
	  a `.quay` signature marker, so unchanged bundles skip the re-sign/re-register churn.
	- [x] `native/build.sh --ship-daemon` ships the booter + icon tool to `Resources/build`,
	  so the shipped daemon can project (without it, projection logged "booter missing").
	- [ ] Re-run projection after app install/update/uninstall — runs on daemon boot only for
	  now; install-time re-projection lands with **Devkit install integration** below.

- [ ] **Full launcher catalog behavior**
	- Filter hidden preview apps from the launcher catalog.
	- Broadcast catalog updates after install.
	- Preserve the shape native UI expects: `{ id, name, glyph }`.

- [ ] **Full agent parity**
	- Add quay `AppController` support: list, inspect, state, run, launch, close, current.
	- Add direct app/window operations via real macOS bundles.
	- Add slash commands and `/new` support.
	- Add bash/fs/fetch/search tools.
	- Add abort support.
	- Seed default `soul.md` for first run.
	- Keep local LM Studio fallback when no ChatGPT account is configured.
	- Preserve user-facing error classification.

- [ ] **Notifications**
	- Register the `notify` capability in the kernel.
	- Route app and agent notifications to launcher sockets.
	- Keep native banner routes compatible with `Notifier.swift`.

- [ ] **Sandbox lifecycle**
	- Port content-addressed worker reuse.
	- Track window open/close retain/release.
	- Evict idle reducer workers after the last window closes.
	- Keep transparent respawn on next dispatch.

- [ ] **Devkit install integration**
	- Fire `onInstalled` after app-code installs an app.
	- Re-project `.app` bundles after install.
	- Broadcast fresh launcher catalog after install.
	- Ensure live previews remain hidden from launcher and OS projection.

- [~] **Build and packaging wiring**
	- [x] `daemon/build-exe.ts`: compile `daemon/main.ts` into one self-contained Bun exe
	  (`--compile`) — HTML surfaces + CSS embedded; `rawText` + `htmlImportmap` build plugins.
	- [x] `native/build.sh --ship-daemon`: embed the daemon exe at `Contents/MacOS/quay-daemon`,
	  copy `/vendor/*` → `Resources/vendor` and builtin roots → `Resources/builtins`, stamp
	  `QuaydRuntime=quay-daemon`. `daemon/main.ts` resolves `Resources/vendor` via `QUAY_SHIPPED`.
	- [x] `pnpm build` now ships the daemon (`--ship-daemon`); `pnpm build:quayd` keeps the
	  legacy quayd ship as a fallback.
	- [x] Shipped `Quay.app` is self-contained (no system node/bun, no repo) and the launcher
	  spawns the embedded daemon on launch (verified: `/system`, `/agent`, `/launcher/chat`,
	  `/vendor/*`, `/app/<id>` all serve from the bundle).
	- [ ] Still pending: `pnpm dev` / `--launcher` spawns quayd-from-source, not the daemon;
	  the daemon listens on a fixed port (Bun default 3000) rather than an ephemeral one; and
	  the daemon still imports `../quayd/*` (resources, builtins, chatgpt, google) — decouple
	  so it stands alone.

- [ ] **Tests**
	- Add/port tests equivalent to quayd's:
		- server/protocol tests
		- host/capability tests
		- materialize/projection tests
		- agent/controller tests
		- devkit install/preview tests
		- sandbox eviction tests

## Already present in daemon

- [x] Bun server entrypoint.
- [x] Kernel + native Volume setup.
- [x] Built-in app seeding.
- [x] Basic app shell and `gui.js` serving.
- [x] Basic app dispatch/state WebSocket.
- [x] Shared React vendor serving.
- [x] Some capabilities: `volume`, `devkit`, `accounts`, `email`, `calendar`, `ai`.
- [x] Basic agent RPC with `prompt/history`.

## Current verdict

Keep the app connected to `quayd` for now. `daemon/` is a useful Bun-native prototype, but it still lacks native/platform parity and protocol parity.
