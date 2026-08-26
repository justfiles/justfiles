---
project: packages/app, packages/create-app
status: todo
---

# dev host: give `pnpm dev` a local AI backend

## Result

An app that declares the `ai` capability can use it in `pnpm dev`. The author adds one plugin
to `vite.config.ts`:

```ts
import { devAi, kernelHost } from '@justfiles/app/vite'

export default defineConfig(({ mode }) => ({
	plugins:
		mode === 'test'
			? []
			: [
					kernelHost({
						id: 'alice.notes',
						name: 'Notes',
						app: 'src/app.ts',
						gui: 'src/gui.ts'
					}),
					devAi()
				]
}))
```

`devAi()` finds whatever the machine already has. One argument changes that:

```ts
devAi()                                   // auto — try what is installed, in a fixed order
devAi('pi-cli')                           // pin one backend
devAi('http://localhost:11434/v1')        // any OpenAI-compatible endpoint
devAi(async ({ prompt, system }) => …)    // your own — a local model, a gateway, anything
```

An app that does not declare `ai` runs no probe and prints no extra line, even with `devAi()`
in the config.

## Why a second plugin, not `kernelHost({ ai })`

Every other `kernelHost` field describes the app: `id`, `name`, `description`, `version`,
`icon` go into the manifest, and `app`, `gui`, `include` are its build entries. All of them
survive into production. A dev-only backend sitting among them reads like production config.

A separate plugin fixes this at the level of shape, not naming:

- It is physically outside the manifest object. Nothing in `kernelHost` changes.
- `apply: 'serve'` makes "dev only" literal, not a convention.
- An author who wants nothing writes no line at all — no key, no `undefined`.
- Adding a plugin is what a Vite user already does to add dev behaviour.

This also matches the earlier instinct about injecting a plugin. The plugin is the unit. It is
just written by hand, once, instead of generated.

Do not make each backend its own plugin. Each is about 20 lines of one function. A plugin per
backend adds an API to maintain and buys nothing.

## Everything lives in `vite.config.ts`

No `.env`, no `JUSTFILES_AI`, no `JUSTFILES_AI_MODEL`, no state file, no first-run write.

The obvious objection to committing the choice is that Alice pins `claude-cli`, Bob has only
`codex`, and Bob's clone breaks. `devAi()` with no argument dissolves it: the committed value
says *auto*, and each machine resolves it locally. A pinned value is then a deliberate
statement, and a missing pinned backend fails with a message that names the fix.

Models need no configuration either. Each CLI already carries a per-machine default that the
developer owns and can change — `~/.pi/agent/settings.json`, `~/.codex/config.toml`, Claude
Code's `/model`. Read the developer's default; do not invent a second place to set one. An
author who needs a specific model per app writes a function.

## The one interface

```ts
export type GenerateText = (input: {
	system: string
	prompt: string
	temperature?: number
	maxTokens?: number
}) => Promise<string>

export type AiBackend = GenerateText | 'pi-cli' | 'claude-cli' | 'codex-cli' | (string & {})
```

`(string & {})` keeps autocomplete on the three ids while still accepting a base URL.

Use the object form, not `(prompt, system)`. The `ai` contract carries `temperature` and
`maxTokens` (`packages/app/capabilities/ai/contract.ts`). A positional pair drops them without
a word, so an app that sets `maxTokens: 100` would behave one way in dev and another in
Frieren. Removing that class of difference is the dev host's whole job. Destructuring keeps the
author's code the same length.

This is also the seam the Mac daemon and the Frieren Worker already build `ai` over
(`packages/agent/ai.capability.ts:26`), so nothing new is invented.

## Built-in backends

Every row is one `GenerateText`. Verified on this machine — record the flags, they are
load-bearing.

| id | command | notes |
| --- | --- | --- |
| `pi-cli` | `pi -p --no-tools --no-session --no-extensions --no-skills --mode text --system-prompt <system>`, prompt on stdin | ~5s. The best fit by a wide margin: `--no-tools` makes it a real text generation rather than an agent turn, `--system-prompt` is honoured, and one binary covers ~40 providers plus OAuth subscriptions. Already this repo's LLM stack. |
| `claude-cli` | `claude -p --output-format text --strict-mcp-config --system-prompt <system>`, prompt on stdin | ~4s. `--system-prompt` replaces the coding-agent prompt, so no tool suppression is needed. `--strict-mcp-config` keeps the developer's MCP servers out. |
| `codex-cli` | `codex exec --ephemeral --skip-git-repo-check -s read-only --color never --output-last-message <tmp> -`, prompt on stdin, answer read from `<tmp>` | ~10s and ~9.4k tokens for a short prompt — the agent harness rides along. No system-prompt flag, so prepend the system text. Say the cost where the backend is named. |
| any `http(s)://` | `POST <url>/chat/completions` | Covers Ollama, LM Studio, vLLM, OpenRouter, and any gateway. When no model is given, `GET <url>/models` and take the first id — correct for OpenAI and for the two local servers, where the catalogue is per-machine. |

That is one `fetch` adapter and three subprocess adapters. No vendor-specific HTTP code at all:
a developer holding `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` reaches it through `pi-cli` or
`claude-cli`, both of which read those variables themselves.

Auto order is by fidelity: `pi-cli`, `claude-cli`, `codex-cli`, `http://localhost:11434/v1`,
`http://localhost:1234/v1`.

**`pi-cli` needs an explicit model or a working default.** A bare `--provider <id>` with no
model made pi resolve its default provider instead and fail on an unrelated expired AWS SSO
token. Pass nothing and let pi use `defaultProvider`/`defaultModel` from
`~/.pi/agent/settings.json`, or pass a full `provider/id`. Never pass `--provider` alone.

Reuse the login the developer already has. Do not port the Codex browser OAuth from
`platform/mac/daemon/chatgpt.ts`. `pi auth check --provider openai-codex --json` already reports
`{"status":"ready","authType":"oauth"}` on a machine where `codex login` has run, so `pi-cli`
delivers the ChatGPT subscription with no OAuth code on our side. Porting it would mean pi-ai
(~35 MB of transitive SDKs) inside a package published to npm as the app SDK, maintained
against undocumented endpoints. An author who disagrees passes a function.

## Detection

Run probes only when resolving `auto`, and only after finding a declared `ai`.

- CLI: walk `process.env.PATH` with `fs.existsSync`. No subprocess — `pi --version`,
  `claude --version` and `codex --version` each cost about a second.
- Local server: `fetch('<url>/models', { signal: AbortSignal.timeout(300) })`.

## No first-run prompt

Moving the choice into `vite.config.ts` removes the reason for one. The prompt existed to
settle an ambiguity and to persist an answer. `devAi()`'s documented order settles the
ambiguity deterministically, and the config is already the persistence.

Keeping it would also mean writing into the author's committed source file, which is the one
thing the config-first design was meant to avoid.

What is left is discovery. Serve it with one line at dev startup, when the app declares `ai`
and the config has no `devAi()`:

```text
ai: `alice.notes` declares the `ai` capability but no dev backend is configured.
    Found `pi` and `codex`. Add `devAi()` to the plugins in vite.config.ts.
```

No interaction, no TTY guard, no hazard under `turbo run dev`, no file written. Print the
resolved backend on a successful run too, so the developer always knows what is spending their
quota:

```text
ai: pi-cli
```

The template ships `devAi()` commented out with a one-line comment, so a generated app is one
uncomment away.

*If an interactive prompt is still wanted:* it needs `process.stdin.isTTY &&
process.stdout.isTTY && !process.env.CI` guards, because `turbo.json` runs `dev` as a
persistent parallel task across packages. It also needs somewhere to write the answer, and
`vite.config.ts` is a poor target — the file can be any shape. Decide that before building it.

## The capability implementation

`@justfiles/app` cannot import `@justfiles/agent` — the dependency runs the other way
(`packages/agent/package.json`). So the dev host writes its own small `implementCapability(ai,
…)` rather than reusing `aiCapability`.

Mirror what `aiCapability` does with no volume: accept `context: 'learning'` only when the app
declared the `context:learning` scope, use an empty fragment, and pass through. This keeps
`app-dictionary` honest about the scope gate without inventing a learning projection the dev
host has no business holding. Reject any other `context` value with `CAPABILITY_INVALID_INPUT`,
and a missing scope with `CAPABILITY_DENIED`. Map a backend failure to `CAPABILITY_FAILED` with
the backend's message.

## Wiring

`vite.ts` carries a hard constraint: *only bare specifiers and type-only imports*, because the
config loader externalises the plugin and resolves it with native Node, which cannot load
relative TypeScript siblings. So `devAi` must be a pure descriptor factory that imports no
implementation:

```ts
// vite.ts
import type { AiBackend } from './capabilities/ai/dev.ts' // type-only — allowed

export function devAi(backend: AiBackend = 'auto'): Plugin {
	return { name: 'kernel-host:ai', apply: 'serve', api: { backend } }
}
```

`dev-server.ts` is reached through `server.ssrLoadModule('@justfiles/app/dev-server')`, so it
may import the implementation freely. It reads the descriptor over Vite's inter-plugin `api`
convention:

```ts
const backend = server.config.plugins.find((p) => p.name === 'kernel-host:ai')?.api?.backend
```

A function passes through untouched — same process, no serialisation.

## Laziness

Read the app's declared capabilities before anything else:

```ts
const declared = await appSandbox({ appId: opts.id, code: '' }).then((s) => s.capabilities())
```

`viteSandbox` ignores `code`, and the dev server loads that module on first dispatch anyway.
With no `ai` declared: no probe, no resolution, no `ai` entry in the registry, and no output.

`devAi()` present but no `ai` declared is a no-op, but print one line — it usually means the
author forgot to declare the capability.

## Files

| File | Change | Rough size |
| --- | --- | --- |
| `packages/app/capabilities/ai/dev.ts` | new — `GenerateText`, `AiBackend`, the four adapters, probes, the resolver, the capability | ~150 lines |
| `packages/app/capabilities/ai/dev.test.ts` | new — see Tests | ~110 lines |
| `packages/app/vite.ts` | add `devAi`; re-export `AiBackend` and `GenerateText` as types | ~10 lines |
| `packages/app/dev-server.ts` | read the plugin descriptor and the declared capabilities; register `ai` in `capabilityRegistry`; the two status lines | ~20 lines |
| `packages/app/package.json` | `"./capabilities/ai/dev"` in `exports` and `publishConfig.exports` | 2 entries |
| `packages/create-app/template/vite.config.ts` | `devAi()` commented out, with a one-line comment | ~3 lines |
| `packages/create-app/template/README.md` | a short "Local AI" section | ~12 lines |
| `docs/app.md` | drop the "Test other capabilities inside Frieren or Kodama" caveat for `ai`; document `devAi` | ~8 lines |

No new dependency in `@justfiles/app`.

## Steps

1. Write `capabilities/ai/dev.ts`: the types, the three CLI adapters, the one OpenAI-compatible
   adapter, the spec resolver, and the capability. No probes yet.
2. Add `devAi` to `vite.ts` and the descriptor read plus registry entry to `dev-server.ts`.
   Verify with an explicit `devAi('pi-cli')` against `apps/crossword`, which needs no
   scope.
3. Add probes and the `auto` order. Verify `devAi()` picks `pi-cli` here.
4. Verify against `apps/dictionary`, which exercises the `context:learning` path.
5. Add the two status lines and the missing-backend hint.
6. Update the template, `docs/app.md`, and the `create-app` README.

## Tests

Inject the environment as one small non-exported `Deps` object — `env`, `which`, `fetch`,
`spawn` — and give the resolver an optional deps argument. Do not export `Deps`.

- A function backend is used as-is.
- `auto` follows the documented order over what `which` reports.
- `auto` with nothing installed yields no capability and the hint line.
- A pinned id that is not installed fails with a message naming the fix.
- A `http://` spec with no model calls `GET /models` once, then `POST /chat/completions`.
- An unknown non-URL string fails with a message listing the valid ids.
- `context: 'learning'` without the scope gives `CAPABILITY_DENIED`; with the scope it passes
  through unchanged.
- Any other `context` value gives `CAPABILITY_INVALID_INPUT`.
- An app that declares no `ai` triggers no probe and registers no capability.
- A backend rejection surfaces as `CAPABILITY_FAILED`.

## Verified facts

Checked on this machine, 2026-08-22:

- `pi` 0.84.2, `claude` 2.1.239, `codex-cli` 0.148.0 all present.
- `pi auth check --provider openai-codex --json` → `{"status":"ready","authType":"oauth"}`.
- `pi -p --no-tools --no-session --no-extensions --no-skills --mode text --model
  openai-codex/gpt-5.4-mini --system-prompt "…"` with stdin returns clean text in ~5s.
- `~/.pi/agent/settings.json` holds `defaultProvider` and `defaultModel`.
- `claude -p --output-format text` returns clean text in ~4s.
- `codex exec --ephemeral --skip-git-repo-check -s read-only` works; ~10s, ~9.4k tokens.
- `vite` 8.0.12 exports `loadEnv` (unused by this plan now, but confirmed).
- `turbo.json` runs `dev` as a persistent, parallel, uncached task.

## The gap this closes

`docs/app.md` says `ai` works in Frieren and Kodama for Mac. The standalone dev host registers
only `volume` and `devkit` (`packages/app/dev-server.ts:135`), so `pnpm dev` answers every AI
call with `CAPABILITY_UNAVAILABLE`. This blocks the `create-app` template and both first-party
AI apps — `app-dictionary` (`src/app.ts:61`, scope `context:learning`) and `app-crossword`
(`src/app.ts:163`).

The kernel gates capabilities by the app's declaration (`packages/app/kernel.capability.ts`),
so registering `ai` in the dev host carries no risk. An app that never declared it cannot reach
it.

## Rejected

- **`kernelHost({ ai })`.** Mixes a dev-only value into fields that all describe the shipped
  app.
- **A plugin per backend.** More machinery than a table of functions.
- **`.env` / `JUSTFILES_AI`.** A second place to look. `devAi()` makes the committed value
  correct on every machine, which was the only thing the env var bought.
- **`JUSTFILES_AI_MODEL`.** Each CLI already has a per-machine default the developer owns.
- **An interactive first-run prompt.** See the section above.
- **Porting the Codex OAuth flow.** `pi-cli` already delivers the same subscription.
- **A third-party Codex-to-OpenAI proxy.** Unaffiliated projects; wrong thing to put in a
  generated app's default path.
