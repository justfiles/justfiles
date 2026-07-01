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
- [ ] Slash commands + `/new` (`commands()` / `command()` are not exposed; the daemon's RPC
  surface is just `prompt`/`history`).
- [ ] `abort` support.
- [ ] Seed a default `soul.md` on first run (without it the agent falls back to the setup
  prompt — quayd's `seedSoul` writes a persona).
- [ ] Local LM Studio fallback — the daemon throws when no ChatGPT account is configured
  (`resolveAgentBackend` → null); quayd falls back to `apiKeyBackend(localLlmStudio())`.
- [ ] User-facing error classification (auth-expired / token-limit routes). The Vite client
  currently shows the raw error string; quayd's `classifyFailure` is not ported. This also
  fixes agent notification pings, which use a fixed `route: { kind: 'chat' }`.
- [ ] Runtime rebuild on credential/model change (quayd's `ensureRuntime` keys on
  `model + revision`; the daemon builds the assistant once per connection).

## Decouple from `quayd/`

- [ ] The daemon still imports out of `../quayd/`: `resources` (`SHIPPED`, in `main.ts` +
  `materialize.ts`), `builtins` (`kernel.ts`), `chatgpt` (`kernel.ts` + `agent.ts`), and
  `google/provider` (`kernel.ts`). Move/duplicate these so the daemon stands alone.
- [ ] The native dev launcher (`native/build.sh --launcher`) still spawns quayd-from-source,
  not the daemon — only `pnpm dev` and the shipped build run the daemon.

## Tests

- [ ] server/protocol tests
- [ ] host/capability tests
- [ ] fuller materialize/projection tests
- [ ] devkit install/preview tests
