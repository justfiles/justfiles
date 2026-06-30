# daemon parity with quayd

`apps/quay/daemon/` is now the **default** runtime: `pnpm dev` runs it (`bun --watch
daemon/main.ts` + Vite) and `pnpm build` ships it (`native/build.sh --ship-daemon`,
self-contained Bun exe + Vite client). `apps/quay/quayd/` is the mature reference and the
fallback ship (`pnpm build:quayd` → `--ship`). The daemon reaches structural parity for
launch/catalog/app-shell/projection but still trails quayd on agent feature-completeness,
notifications, sandbox eviction, install-time hooks, and tests — and it still imports a few
modules out of `../quayd/`, so the two aren't yet decoupled.

> Note: the browser surfaces (launcher, chat, app shell, shared React vendor) moved to Vite
> under `ui/` — built into `ui/dist/client` and served verbatim by the daemon (zero
> frontend bundling in the daemon). The old `daemon/launcher/*.tsx` surfaces are gone.

## Done since this doc was first written

- [x] **Discovery/runtime file** (`daemon/fs.ts`)
	- Writes `~/Library/Application Support/quay/runtime.json` with `{ port, token, pid }`
	  on boot and clears it on exit (SIGINT/SIGTERM/beforeExit).
	- Matches the native Swift `Quayd.ensure()` discovery path.

- [x] **Native protocol compatibility**
	- Catalog: the native launcher (now the Vite `ui/launcher`) opens `ws://…/system` and
	  decodes the pushed `{ type: "apps", apps }` frame — full `AppManifest[]`, no
	  `list`/`commands` request. The client derives its own glyph/icon from the manifest.
	- Chat: the native shell embeds `launcher/chat.html` (Vite `ui/launcher/chat.tsx`) in a
	  transparent WKWebView; it drives the daemon's `/agent` Cap'n Web RPC (`prompt`/
	  `history`). The session→transcript projection and error rendering that quayd's
	  `createQuayAgent` did server-side now live in the client (`ui/launcher/agentChat.tsx`).
	- Watchdog: `QUAY_OWNER_PID` ties the daemon's lifetime to the owning app via a 1s
	  `kill(pid,0)` liveness poll, so the background daemon never outlives the launcher.

- [x] **`.app` projection** (`daemon/materialize.ts`, wired in `daemon/main.ts`)
	- Materializes installed apps into `~/Applications/Quay Apps/*.app` — shared booter
	  binary + per-app `Info.plist` + generated icon, no app code (bytes stay in the Volume,
	  served over http). Preview apps (`preview.*`) are filtered out.
	- Stamps `Info.plist`, app id, icon, and daemon spawn keys (`QuaydRuntime` = the absolute
	  daemon path: shipped `quay-daemon`, dev `bun` on `daemon/main.ts`; `QuaydScript`/
	  `QuaydArgs` empty when shipped), so a cold-launched bundle respawns the daemon.
	- Ad-hoc signs (`codesign -s -`) and registers bundles with LaunchServices (`lsregister`).
	- Reconciles one-way from kernel catalog → OS projection (Volume wins); idempotent via a
	  `.quay` signature marker, so unchanged bundles skip the re-sign/re-register churn.
	- `native/build.sh --ship-daemon` ships the booter + icon tool to `Resources/build`.

- [x] **Agent app control** (`daemon/agent.ts`)
	- `createAppController` is implemented and wired into the agent: `list`, `inspect`,
	  `state`, `run`, `launch`, `close`, `current`, with preview apps hidden and `run`
	  stamped as `actor: 'agent'`. Covered by `daemon/agent.test.ts`.
	- `launch`/`close` drive REAL macOS bundles (`open` / `pkill -f` the materialized .app),
	  dispatching into the SAME kernel the windows subscribe to, so an open window updates
	  live the moment the agent acts.
	- A bash tool (`createJustBashTool` + `createAppShellCommand`) gives the agent shell
	  access over the Volume and the `app` command.

- [x] **Build, packaging, dev wiring**
	- `daemon/build-exe.ts`: compiles `daemon/main.ts` into one self-contained Bun exe
	  (`--compile`); the `raw-text` plugin handles the agent's `?raw` prompt imports.
	- `native/build.sh --ship-daemon`: embeds the daemon exe at `Contents/MacOS/quay-daemon`,
	  copies the Vite client (`ui/dist/client` → `Resources/client`), builtin roots, and the
	  booter/icon tool; stamps `QuaydRuntime=quay-daemon`.
	- `pnpm build` ships the daemon by default; `pnpm build:quayd` keeps the legacy quayd ship.
	- `pnpm dev` runs the daemon (`bun --watch daemon/main.ts`) + `vite build --watch`.
	- **Ephemeral port**: shipped the daemon binds an OS-assigned port (`0`) on loopback —
	  two installs/versions never fight over a fixed number; the shell discovers it via
	  `runtime.json`. Dev keeps a fixed `3000` (overridable via `PORT`) so an open tab
	  survives `bun --watch` restarts.
	- Shipped `Quay.app` is self-contained (no system node/bun, no repo) and the launcher
	  spawns the embedded daemon on launch.

## Still missing before full parity

- [ ] **Catalog broadcast on install**
	- The `/system` socket pushes the catalog on connect, but the daemon does not
	  re-broadcast after an install/update/uninstall — `main.ts`'s kernel subscription only
	  fans out `app.update` state pushes, not catalog changes. (Preview-app filtering is
	  already done.)

- [ ] **Re-run projection after install/update/uninstall**
	- `materialize.reconcileProjection` runs once on daemon boot only. Install-time
	  re-projection lands with **Devkit install integration** below.

- [~] **Full agent parity** (`daemon/agent.ts` vs `quayd/agent.ts`)
	- [x] AppController: list, inspect, state, run, launch, close, current.
	- [x] Direct app/window operations via real macOS bundles.
	- [x] bash tool over the Volume + `app` command.
	- [ ] fs / fetch / search / `ask_user` tools (quayd registers all four; the daemon only
	  wires bash).
	- [ ] Slash commands + `/new` (`commands()` / `command()` are not exposed; the daemon's
	  RPC surface is just `prompt`/`history`).
	- [ ] `abort` support.
	- [ ] Seed a default `soul.md` on first run (without it the agent falls back to the setup
	  prompt — quayd's `seedSoul` writes a persona).
	- [ ] Local LM Studio fallback — the daemon throws when no ChatGPT account is configured
	  (`resolveAgentBackend` → null); quayd falls back to `apiKeyBackend(localLlmStudio())`.
	- [ ] User-facing error classification (auth-expired / token-limit routes). The Vite
	  client currently shows the raw error string; quayd's `classifyFailure` is not ported.
	- [ ] Runtime rebuild on credential/model change (quayd's `ensureRuntime` keys on
	  `model + revision`; the daemon builds the assistant once per connection).

- [x] **Notifications**
	- `notify` capability registered in the daemon kernel (`daemon/kernel.ts` →
	  `notifyHost(notificationChannel)`); the kernel stamps `source = appId`, so a
	  sandboxed app can raise a banner that routes back to it.
	- A deferred channel (`daemon/notify.ts`) is the convergence point; `main.ts` binds
	  the real sink once the server is up — it fans `{ type: 'notification', notification }`
	  out to every launcher `/system` socket (the `notify` pub/sub topic).
	- Agent pings: `daemon/agent.ts` emits `source: 'agent'` notifications on turn
	  completion and on error (coalesced under one `threadId`).
	- Native-compatible: the wire shape matches `Notifier.swift` / `CatalogClient`, which
	  already decodes `{type:'notification', notification}` on `/system` and projects it
	  onto the OS banner.
	- Remaining: agent pings use a fixed `route: { kind: 'chat' }` — auth/token-limit
	  routing into Settings/chat lands with agent **error classification** above.

- [~] **Sandbox lifecycle** (`daemon/sandbox.ts`)
	- [x] Content-addressed worker reuse: one cell per `appId`, keyed on `code`; replaced
	  (and the old worker stopped) when the code changes; transparent respawn on next dispatch.
	- [ ] Track window open/close retain/release.
	- [ ] Evict idle reducer workers after the last window closes (today a cell lives until
	  its code changes — nothing reaps it when all windows close).

- [ ] **Devkit install integration**
	- Fire `onInstalled` after app-code installs an app.
	- Re-project `.app` bundles + re-broadcast the launcher catalog after install.
	- Keep live previews hidden from the launcher and OS projection (filter exists; the
	  install hook to re-run it does not).

- [ ] **Decouple from `quayd/`**
	- The daemon still imports out of `../quayd/`: `resources` (`SHIPPED`, in `main.ts` +
	  `materialize.ts`), `builtins` (`kernel.ts`), `chatgpt` (`kernel.ts` + `agent.ts`), and
	  `google/provider` (`kernel.ts`). Move/duplicate these so the daemon stands alone.
	- The native dev launcher (`native/build.sh --launcher`) still spawns quayd-from-source,
	  not the daemon — only `pnpm dev` and the shipped build run the daemon.

- [~] **Tests**
	- [x] Controller test (`daemon/agent.test.ts`).
	- [x] Projection signature test (`daemon/materialize.test.ts`).
	- [ ] server/protocol tests
	- [ ] host/capability tests
	- [ ] fuller materialize/projection tests
	- [ ] devkit install/preview tests
	- [ ] sandbox eviction tests

## Already present in daemon

- [x] Bun server entrypoint, loopback-only, ephemeral port when shipped.
- [x] Kernel + native Volume setup.
- [x] Built-in app seeding (`reconcileBuiltins`).
- [x] App shell + `gui.js` + icon serving; static Vite client serving.
- [x] App dispatch/state WebSocket over Bun pub/sub (`app:<id>` topics).
- [x] Shared React vendor serving (Vite import-map vendor bundles).
- [x] Capabilities: `volume`, `devkit`, `accounts`, `email`, `calendar`, `ai`, `notify`.
- [x] Notification fan-out to launcher `/system` sockets (app + agent → OS banner).
- [x] Agent RPC (`prompt`/`history`) over Cap'n Web with app-control + bash tooling.
- [x] `.app` projection into `~/Applications/Quay Apps`.

## Current verdict

The daemon is now the default dev and shipped runtime (`pnpm dev`, `pnpm build`), with quayd
retained as the reference and fallback ship (`pnpm build:quayd`). Structural parity —
launch, catalog, app shell, projection, agent app-control — is in place. The remaining work
to fully retire quayd is agent feature-completeness (slash commands, abort, fs/fetch/search/
ask_user tools, soul seeding, LM Studio fallback, error classification), sandbox eviction,
install-time projection/catalog hooks, decoupling the daemon from `../quayd/*`, and broader
tests. Notifications are now at parity.
