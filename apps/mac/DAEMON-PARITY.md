# daemon parity with quayd — remaining work

`apps/quay/daemon/` is the **default** runtime: `pnpm dev` runs it (`bun --watch
daemon/main.ts` + Vite) and `pnpm build` ships it (`native/build.sh --ship-daemon`,
self-contained Bun exe + Vite client). `apps/quay/quayd/` is the mature reference and the
fallback ship (`pnpm build:quayd` → `--ship`). Structural parity — launch, catalog, app
shell, `.app` projection, agent app-control, notifications, sandbox lifecycle, and the
install-time catalog/projection reconcile — is in place. What's left to fully retire quayd:

## Agent feature-completeness (`daemon/agent.ts` vs `quayd/agent.ts`)

- [x] `search` + `ask_user` tools. The daemon now wires just-bash (a full shell over the
  Volume) + `fetch` + `search` + `ask_user` + `read_doc`, matching the tools quayd wired.
  `ask_user`
  records the posed question and `AgentImpl.prompt` surfaces it (with a `question`
  notification ping) once the turn returns; the user's pick is the next prompt.
  (The old `fs` read/write/ls/mkdir/rm tools were retired — just-bash's shell built-ins
  replace them — so they're no longer a parity gap.) `read_doc` (+ the docs system-prompt
  block) surfaces the @justfiles/agent DOCS catalogue: `createAssistant` gets a `readDoc`
  that loads repo-root `docs/*.md` (via `daemon/resources.ts` `DOCS_DIR` — the repo in dev,
  `Resources/docs` shipped, copied by `build.sh --ship-daemon`).
- [x] Slash commands + `/new`. Commands are a **daemon** concept (`daemon/commands.ts`),
  fully off the agent: `@justfiles/agent` exposes only skill primitives (`listSkills` for
  LLM-free enumeration + `Assistant.applySkill`/`readSkill`) and has no `command` concept.
  The daemon owns the registry (`SYSTEM_COMMANDS` = `/new` + `/debug`, projected alongside
  one entry per skill via `buildCommands`) and dispatch (`dispatchCommand`), handled over
  the **`/system`** socket (request/reply), not the agent socket. `dispatchCommand` returns
  a `CommandResult` (`{ show: 'chat' }` | `{ show: 'text', body }` | `undefined`) so the
  return drives the launcher: `/new` clears the session + reveals chat, a skill runs on the
  shared agent via `applySkill` (its turn streams into the live transcript), `/debug`
  renders a one-off text panel (also logged to quayd.log). Command output never touches the
  session. The catalogue is pushed on the `/system` `commands` frame (built from
  `listSkills`, no assistant/backend — works offline); native `Launcher` dispatches over
  `CatalogClient.runCommand` and acts on the `CommandResult`.
- [x] Subscription-based chat. The `/agent` socket is a **live view of one shared session**
  (plain WebSocket + Bun `agent` pub/sub topic, no capnweb): every turn broadcasts the full
  transcript (`history`) plus `busy`/`error`; the client only sends `{ prompt }`. Because a
  `/skill` dispatched over `/system` runs on the same shared `Assistant`, its turn surfaces
  in every open chat naturally — no deliberate daemon→UI push per action, just the session
  the transcript observes. `AgentImpl`/`agentRpcTarget` are gone; the daemon keeps one
  memoised session (`getAgent`, reset on failure) driven by `promptAgent`/`dispatchCommand`.
- [x] `abort` support. The `/agent` socket now carries an `{ type: 'abort' }` request
  (`AgentRequest`) alongside `prompt`; `main.ts` routes it to `abortAgent`, which cancels the
  in-flight turn on the shared session via `Assistant.abort` (guarded on the memoised session
  so a cold daemon never builds an agent just to cancel nothing). The native Stop button
  already called `window.quayAbort` — `chat.tsx` now defines it, wired to `useAgentChat.abort`,
  which sends the frame. The aborted turn's `busy:false`/`error` push flows back over the
  socket as usual.
- [x] User-facing error classification (auth-expired / token-limit routes). `daemon/agent.ts`
  now ports quayd's `classifyFailure`: a failed turn's raw error is mapped to a user-facing
  body + a fix-it `Route` (401/expired → “reconnect in Settings → Accounts”, context/token-
  limit/429 → “start a new chat”, else a generic chat error). `runTurn`'s catch broadcasts the
  classified body on the `/agent` `error` frame (the raw error still hits `quayd.log`) and
  pings the notification channel with it — so the in-page launcher (`ui/launcher/main.tsx`)
  status line already shows the friendly message, and the native chat surface
  (`ui/launcher/chat.tsx`), which used to drop the error, now appends it as a trailing error
  block in the transcript. `ping` takes the `Route` (info/question stay `{ kind: 'chat' }`),
  so an auth-expired banner routes to Accounts instead of the hardcoded chat.
- [x] Runtime rebuild on credential/model change (quayd's `ensureRuntime` keys on
  `model + revision`; the daemon now does the same). `getAgent` re-resolves the backend on
  every call and caches the built session keyed on `${model.id} ${revision}` (the token's
  opaque fingerprint), rebuilding when the user switches models, reconnects an account, or
  `resolveAgentBackend` rotates a near-expiry OAuth token. A built-once assistant sealed the
  token in its `streamFn` closure and 401'd forever once it expired (turn failures don't
  reset the cache) — now the refreshed token changes the `revision`, so the next prompt
  rebuilds. Lossless: the conversation persists to the Volume session, which the fresh
  assistant reloads. `abortAgent` guards on the cached session (cold daemon = no-op).

## Decouple from `quayd/`

- [x] The daemon no longer imports out of `../quayd/`: `resources` (`SHIPPED`),
  `builtins`, `chatgpt`, and `google/provider` were copied into `daemon/` (a slimmed
  `daemon/resources.ts` — SHIPPED + builtins root only, since the daemon serves its client
  from Vite and needs none of quayd's assets/docs/design roots — plus `daemon/builtins.ts`,
  `daemon/chatgpt.ts`, and `daemon/google/`). The quayd originals stay for later cleanup.
- [x] The native dev launcher (`native/build.sh --launcher`) now spawns the daemon from
  source, not quayd. `build_launcher` builds the Vite client (`pnpm run ui:build` →
  `ui/dist/client`, the daemon's browser surfaces) instead of quayd's `build-assets.ts`, and
  `stamp_daemon` stamps `QuaydRuntime=<bun>` / `QuaydScript=daemon/main.ts` / `QuaydArgs=[]`
  into the launcher plist (the daemon is Bun-only — `Bun.serve`/pub-sub/`Bun.file` — so
  quayd's node escape hatch and the `--runtime node|bun` flag are gone; the launcher always
  spawns under bun). `Quayd.spawn()` (Launcher.swift) is unchanged — it execs the stamped
  keys verbatim. Projected `.app` booters already re-stamp to the daemon
  (`materialize.ts` keys on `process.execPath` + `daemon/main.ts`), so a Spotlight-cold app
  respawns the daemon too. `native/relaunch.sh` already kills `daemon/main.ts`.

## Tests

- [x] server/protocol tests (`main.ts` Bun.serve routing + `/system`/`/agent` sockets,
  `protocol.ts`). `main.ts` now exports `createServer(options)` — the Bun.serve routing +
  the three sockets, wired to the module singletons — while the process lifecycle
  (runtime.json handshake, owner watchdog, SIGINT/SIGTERM) moved behind an
  `if (import.meta.main) void main()` guard, so importing the module for a test has zero
  process-level side effects. `createServer` takes an injectable `projectApps` (default
  `reconcileProjection`) so a test passes a no-op and never touches ~/Applications or runs
  codesign/lsregister. `daemon/server.bun.test.ts` (Bun — Bun.serve + pub/sub) stands one up
  over a temp Volume (`QUAY_SUPPORT_DIR`, ephemeral port) and drives the HTTP routes
  (per-app `gui.js`/`icon` + their 404s + the serveClient guard) and the wire protocol on
  every socket: `/system` (catalog + command menu on connect, `/debug`+`/new` dispatch),
  `/agent` (empty-transcript snapshot + a prompt turn surfacing a classified error offline),
  and `/app/:id` (initial state push + an increment dispatch round-trip with the state
  fan-out). This drove out a parity bug: the `gui.js` route 500'd on an unknown app id where
  the icon route (and quayd) 404 — now fixed to 404.
- [x] kernel/capability wiring tests (`kernel.ts` — the daemon has no `host.ts`). `getKernel`
  was split into a `buildKernel(fs)` seam (the memoised singleton just wraps
  `getVolume().then(buildKernel)`), so a test builds a throwaway kernel over a temp Volume
  without the singleton. `daemon/kernel.bun.test.ts` (Bun — the reducer sandbox uses blob-URL
  Workers) mirrors quayd's `host.test.ts`: it asserts `buildKernel` seeds the builtin catalog
  and that Files, dispatching `refresh`, reads the REAL volume through the system-scoped
  `volume` capability (the scan walks `/applications/*`) — proving a capability-using reducer
  reaches real files through the daemon's own wiring, not a stub. (`getVolume` also gained a
  lazy `QUAY_SUPPORT_DIR` override + a `mkdir` of the volume root, so a run over a fresh
  support dir — tests, or a truly first-ever boot — no longer ENOENTs on `fsStore`.)
- [x] fuller materialize/projection tests (`materialize.test.ts` only covered
  `projectionSignature` today). `daemon/materialize.test.ts` now exhaustively pins the
  signature — the reconcile's entire rebuild-vs-skip story: identical inputs → identical
  signature (the skip-unchanged path), and a distinct signature on every rebuild trigger
  (rename, version bump, id, a fresh booter mtime that refreshes every bundle, icon-bytes or
  icon-path change, gaining an icon), plus that a bundle with no icon ignores its `iconPath`.
- [x] devkit install/preview tests (`kernel.ts` `devkitCapability` + toolchain worker).
  `daemon/devkit.bun.test.ts` (Bun — reducer sandbox + `Bun.build` in the toolchain worker)
  mirrors quayd's `devkit.test.ts` over a `buildKernel` temp Volume: it drives Code
  (`app.code`) the way its GUI does — create → open → install — and asserts the freshly-built
  app lands in the catalog `kernel.list()` serves, then that `run` installs a hidden,
  servable `.preview.*` app (off the catalog, gui.js reads, runner returns the app-shell URL)
  that `stop` uninstalls. This exercises the daemon's devkit wiring end to end: the toolchain
  worker's `compile`/`typecheck` and the `quayRunner` preview mount/stop.
