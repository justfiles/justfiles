# daemon parity with quayd — remaining work

`apps/quay/daemon/` is the **default** runtime: `pnpm dev` runs it (`bun --watch
daemon/main.ts` + Vite) and `pnpm build` ships it (`native/build.sh --ship-daemon`,
self-contained Bun exe + Vite client). `apps/quay/quayd/` is the mature reference and the
fallback ship (`pnpm build:quayd` → `--ship`). Structural parity — launch, catalog, app
shell, `.app` projection, agent app-control, notifications, sandbox lifecycle, and the
install-time catalog/projection reconcile — is in place. What's left to fully retire quayd:

## Agent feature-completeness (`daemon/agent.ts` vs `quayd/agent.ts`)

- [x] `search` + `ask_user` tools. The daemon now wires just-bash (a full shell over the
  Volume) + `fetch` + `search` + `ask_user`, matching the tools quayd wires. `ask_user`
  records the posed question and `AgentImpl.prompt` surfaces it (with a `question`
  notification ping) once the turn returns; the user's pick is the next prompt.
  (The old `fs` read/write/ls/mkdir/rm tools were retired — just-bash's shell built-ins
  replace them — so they're no longer a parity gap; quayd's agent is now `fetch` +
  `search` + `ask_user` only, no shell/app-control.)
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

- [ ] server/protocol tests (`main.ts` Bun.serve routing + `/system`/`/agent` sockets,
  `protocol.ts`)
- [ ] kernel/capability wiring tests (`kernel.ts` — the daemon has no `host.ts`)
- [ ] fuller materialize/projection tests (`materialize.test.ts` only covers
  `projectionSignature` today)
- [ ] devkit install/preview tests (`kernel.ts` `devkitCapability` + toolchain worker)
