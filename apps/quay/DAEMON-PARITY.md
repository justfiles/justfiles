# daemon parity with quayd

`apps/quay/daemon/` is not yet at feature parity with `apps/quay/quayd/`. It has a partial Bun-native host, but it is not a drop-in replacement for the native Quay app yet.

## Missing before switching the app to daemon

- [x] **Discovery/runtime file**
	- Write `~/Library/Application Support/quay/runtime.json` with `{ port, token, pid }`.
	- Clear it on daemon exit.
	- Match the native Swift `Quayd.ensure()` discovery path.

- [ ] **Native protocol compatibility**
	- Support the native launcher's expected privileged WebSocket:
		- `ws://127.0.0.1:<port>/?token=...`
		- request: `{ type: "list" }`
		- response: `{ type: "catalog", apps }`
		- request: `{ type: "commands" }`
		- response: `{ type: "commands", commands }`
		- push: `{ type: "notification", notification }`
	- Or update the Swift launcher to the daemon's `/system` + `/agent` protocol.

- [ ] **`.app` projection**
	- Materialize installed apps into `~/Applications/Quay Apps/*.app`.
	- Stamp `Info.plist`, app id, icon, and daemon spawn keys.
	- Ad-hoc sign and register bundles with LaunchServices.
	- Reconcile one-way from kernel catalog to OS projection.
	- Re-run projection after app install/update/uninstall.

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

- [ ] **Build and packaging wiring**
	- Update `package.json` scripts if daemon becomes the default.
	- Update `native/build.sh` to stamp daemon paths instead of `quayd` paths.
	- Add daemon production build/ship resource handling.
	- Ensure shipped `Quay.app` is self-contained.
	- Stop importing implementation pieces from `../quayd/*` where daemon should stand alone.

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
