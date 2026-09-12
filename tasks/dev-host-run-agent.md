---
project: platform/ai
status: todo
---

# Dev host: delegated tasks using the developer's AI tools

Plan updated 2026-09-12. Extend the standalone Vite dev host so apps can use `ai.runAgent` and `ai.cancelAgent` with the developer's existing AI tools. Learn is the first consumer: research a topic, read existing learning files, write a candidate lesson, and return a final reply. Keep the published app API and `generateText` behavior unchanged.

## Existing implementation

The local text workflow was introduced in commit `c28798921`, **feat(app): add local AI to the dev host (#567)**. Reuse these parts:

| Source | Existing responsibility |
| --- | --- |
| [devAi](../packages/app/vite.ts) | Opt-in Vite plugin; defaults to automatic backend selection. |
| [Dev AI adapter](../packages/app/capabilities/ai/dev.ts) | Detects Pi, Claude Code, Codex, Ollama, and LM Studio; accepts an explicit CLI, HTTP URL, or text function. Launches CLIs with the developer's environment and collects final output. |
| [Dev adapter tests](../packages/app/capabilities/ai/dev.test.ts) | Backend order, missing-backend guidance, subprocess errors, HTTP completion, and text capability behavior. |
| [Dev server](../packages/app/dev-server.ts) | Registers the AI capability with the kernel and provides persistent `.justfiles/dev/` storage. |
| [AI capability](../packages/agent/ai.capability.ts) | Existing delegated-request admission, scope checks, cancellation, timeout, and cleanup semantics. |
| [Delegated runner](../packages/agent/run-agent.ts) and [app tool](../packages/agent/app-tool.ts) | Fresh context, research tools, bounded execution, and invocation of the calling app's capabilities. |
| [Capability call](../packages/app/capabilities/types.ts) | Trusted app identity, bindings, and an invocation callback supplied by the executing kernel. |

The current CLI path already uses developer-installed tools and their normal authentication. Pi text calls disable tools; Codex uses an ephemeral read-only invocation and a final-message file. The shared subprocess helper has no cancellation or tool bridge. The HTTP path performs one chat-completion request. In SDK 0.17.0 the dev capability explicitly returns unavailable for both agent methods.

## Decisions

- Preserve `runAgent({ requestId, prompt })` and `cancelAgent({ requestId })`. No workspace argument, new scopes, durable sessions, jobs, polling, or streaming API.
- A delegated task inherits all of the calling app's declared capability bindings, with that app's identity and scopes. It may inspect other folders and use other capabilities the app already has. A path in a prompt does not reduce those permissions.
- Apps own task instructions and file layouts. Learn asks the agent to put teaching proposals in a candidate folder and leave learner notes/progress alone, then validates and publishes candidates itself. These are app workflow rules, not a platform filesystem sandbox.
- Reuse CLI discovery, explicit selection, developer authentication, and final-output handling. Do not copy authentication into app files or require a separate model account for development.
- Support agent execution through the existing Pi, Claude Code, and Codex choices. Keep HTTP URLs and custom `GenerateText` functions text-only initially; they do not supply an agent/tool loop. Report this limitation clearly rather than treating a text completion as an agent task.
- Keep the core small: one capability adapter, one active-request map, and contained CLI-specific launch/transport code. The CLI supplies its agent loop. Reuse lifecycle/tool behavior from the host implementation without adding a dependency cycle from `@justfiles/app` back to the whole `@justfiles/agent` package.

## Implementation

### 1. Prove a CLI can call back into the app

Start with one installed CLI and a tiny fixture app. Inspect the CLI's current supported noninteractive tool-extension interface before choosing flags or a transport. Prove a fresh process can read through one app volume binding, write through another, research a public page, and return final text. Do not infer write support from a successful text response.

Expose the existing app capability tool through the CLI's supported tool mechanism, such as MCP or a bundled extension. Keep the transport internal to the dev adapter. The bridge must:

- Take bindings and the invocation callback from `ctx.app`, supplied by the kernel. Tool requests provide the binding name, method, and arguments; they cannot choose another app identity or invent grants.
- Preserve the app tool's API-reference discovery and encoding for bytes and bigint values.
- Route app data operations through `ctx.app.invoke`, so reads/writes use the existing capability implementations and the same persistent dev volume. Do not write directly into storage internals or create a second filesystem copy.
- Provide research tools with the existing public-page retrieval behavior. Keep unrelated ambient CLI plugins, project instructions, and host filesystem tools out of the app tool surface; CLI authentication is separate from the task's authority.
- Bind any temporary IPC endpoint/configuration to the active invocation and dispose it afterwards. If loopback transport is needed, restrict and authenticate it; it must not become an unprotected capability endpoint on the Vite server.

The acceptance case must read two folders accessible to the app, including one outside the prompt's suggested output folder. This establishes permission inheritance while still demonstrating that the task follows the requested output layout.

### 2. Extend backend resolution and capability dispatch

Keep the existing public `devAi()` options and text backend selection order. Add an optional agent execution function to the internal resolved backend, taking the prompt, trusted app tool context, and an abort signal. Keep CLI arguments for text generation and agent execution separate.

Complete adapters for Pi, Claude Code, and Codex using the transport established above. Package their bridge/extension assets with the released SDK; standalone apps must not need a platform checkout. Verify each CLI can run without interactive terminal questions using its existing login and explicitly supplied app tools. If a required CLI feature/version is missing, name it in the error rather than silently changing backend or permissions.

Replace the dev capability's agent-method stubs. Check the `agent` AI scope, validate inputs, and require trusted app context. An unsupported backend still returns `CAPABILITY_UNAVAILABLE`; rejected overlapping requests use the existing capability error semantics. Startup diagnostics distinguish text support from agent support. Missing CLI/login errors should remain actionable.

### 3. Match request lifetime and cancellation

Follow the existing host lifecycle, sharing small reusable pieces where practical:

- Register one active request per app before asynchronous setup. Keep the request ID, abort controller, child process, and bridge handles only in memory. Reject overlaps; do not queue or automatically retry tasks.
- Every invocation starts with fresh model context. Do not resume a developer conversation or automatically load Learn's saved conversations; Learn supplies relevant history in its prompt.
- `cancelAgent` only affects the matching active request for the calling app. Repeated cancellation is safe; unknown, stale, and other-app IDs cannot stop new work.
- Abort setup, research, and the subprocess. Stop accepting new tool calls immediately, terminate child processes as needed, and wait for in-flight capability operations to settle before releasing the app's slot. Cancellation resolves the original call with `{ cancelled: true }`; ordinary failures and timeouts reject.
- Apply the existing ten-minute and 50-tool-execution limits. Count tools at the bridge so CLI defaults cannot silently evade the limit. Bound captured output and preserve a useful final error without dumping credentials or tool traces into the app response.
- Close bridges, timers, temporary configuration/output files, and process handles in `finally`. Return the completed assistant reply only. Completed capability writes survive failure/cancellation.

### 4. Integrate dev-server lifecycle and package the change

Wire the adapter through the current dev server's capability registration. The trusted app callback already points back to the executing kernel; do not introduce an agent-specific volume grant or let the prompt select a disk root.

Add explicit disposal for server shutdown and headless-app reload. Stop active children and reject new bridge calls before disposing/replacing their kernel context; drain in-flight operations. Restarting the server must show saved files with no active requests and must never replay an interrupted call. Preserve ordinary GUI refresh behavior and persistent storage.

Document backend prerequisites and unsupported text-only backends in the standalone authoring docs and template README. Verify package contents from an installed/tarball SDK in a standalone fixture, then release through the normal SDK publication workflow. Learn can upgrade to the exact released version afterwards.

## Verification and acceptance

Use Vitest with fake process/transport boundaries for deterministic coverage; keep real authenticated CLI smoke tests explicit and outside unattended unit tests.

- Existing `generateText`, backend selection, and error tests still pass unchanged in behavior.
- Each CLI adapter sends a fresh request, registers the app tools, returns only the final reply, and cleans up on success, launch failure, malformed output, and cancellation.
- Through real app procedure and command dispatch, tool calls retain the calling app's identity and scopes. Test multiple volume bindings, access across folders, an inherited non-filesystem capability, undeclared-binding rejection, and two apps with different grants.
- Exercise busy handling, cancellation during setup/model/tool execution, stale IDs, timeout/tool limits, and cancellation racing completion. A slow write must settle before a replacement request can start.
- Under the real dev server, research a public source and write a file through the app capability. The GUI must read it through its normal procedure, remain responsive, and expose Stop.
- Restart the server after a completed write and after cancellation. Verify file persistence, empty execution state, and no replay. Verify shutdown/reload leaves no child process or bridge serving a stale app callback.
- Smoke-test each advertised CLI backend using the developer's existing login. A model server or text function must continue to support text and explain why agent execution is unavailable.
- Run the repository checks appropriate to the implementation and verify the published SDK bundle has all required bridge assets, with no workspace-only imports.

Done means a standalone app can research, inspect its existing data, author files, stop an invocation, and reopen saved results using the released dev host. Learn's lesson formats, prompts, candidate validation, MDX renderer, and publication behavior remain Learn implementation work.
