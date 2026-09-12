---
project: platform/ai
status: done
---

# Dev host: CLI-backed model providers for the JustFiles agent

Plan updated 2026-09-12. Extend the standalone Vite dev host so apps can use `ai.runAgent` and `ai.cancelAgent` through JustFiles' internal Pi agent. A developer-installed CLI supplies one model response at a time and manages its own authentication. Learn is the first consumer: research a topic, read learning files, write a candidate lesson, and return a final reply. Keep the published app API and existing `generateText` behavior unchanged.

## Architecture and decisions

The AI capability is the app's access to AI infrastructure. `runAgent` is a harness operation: JustFiles defines the tools, executes them, and owns the conversation, permissions, limits, and cancellation. The CLI-backed provider adapts request/response text into Pi's model interface.

```text
App calls ai.runAgent
  JustFiles creates an internal Pi agent
    provider encodes conversation + tool schemas
      selected CLI produces one response using its existing login
    provider decodes final text or a requested tool call
  Pi executes requested tools and repeats until finished
App receives the final reply
```

- Preserve `runAgent({ requestId, prompt })` and `cancelAgent({ requestId })`. No workspace argument, new scopes, durable sessions, jobs, polling, or public streaming API.
- A delegated task inherits all of the calling app's declared capability bindings, with that app's identity and scopes. It may inspect other folders and use other capabilities the app already has. A path in a prompt does not reduce those permissions.
- Apps own task instructions and file layouts. Learn asks the agent to put teaching proposals in a candidate folder and leave learner notes/progress alone, then validates and publishes candidates itself. These are app workflow rules, not a platform filesystem sandbox.
- Run the harness and provider adapter on the developer's machine. Use the CLI's existing login and model configuration; the CLI owns credential storage and refresh. No credential extraction, shared token store, separate model account, or JustFiles-hosted service is required.
- Reuse existing backend discovery, explicit selection, and one-shot text adapters. Keep CLI-specific launch details contained; share the conversation/response codec across backends.
- The CLI must run with its own tools and ambient customizations disabled, with fresh context for each request. App tools are described in the prompt and executed only by the internal Pi agent. No MCP callback bridge, CLI extension, or app capability endpoint is needed.
- HTTP endpoints and custom text functions can also feed this provider codec. They do not need their own agent loop. Preserve their existing text support; advertise agent support when the response protocol and cancellation contract are verified. A native model adapter can be added independently if useful, but is not required for this change.

## Existing implementation

The local text workflow was introduced in commit `c28798921`, **feat(app): add local AI to the dev host (#567)**. Reuse these parts:

| Source | Existing responsibility |
| --- | --- |
| [devAi](../packages/app/vite.ts) | Opt-in Vite plugin with automatic or explicit backend selection. |
| [Dev AI adapter](../packages/app/capabilities/ai/dev.ts) | Finds Pi, Claude Code, Codex, Ollama, and LM Studio; accepts a CLI, HTTP URL, or text function. Spawns CLIs with the developer's environment and collects final output. |
| [Dev adapter tests](../packages/app/capabilities/ai/dev.test.ts) | Discovery order, custom functions, subprocess errors, HTTP completion, and text capability behavior. |
| [Dev server](../packages/app/dev-server.ts) | Registers capabilities with the kernel and persists `.justfiles/dev/` storage. |
| [AgentBackend](../packages/agent/llm.ts) and [Pi construction](../packages/agent/llm.agent.ts) | Inject model operations through `streamFn` and `completeFn`; the agent object does not need credentials. |
| [AI capability](../packages/agent/ai.capability.ts) | Request admission, scope checks, cancellation, timeout, and cleanup. |
| [Delegated runner](../packages/agent/run-agent.ts) and [app tool](../packages/agent/app-tool.ts) | Fresh context, research tools, execution limits, and invocation of the app's bindings. |
| [Capability call](../packages/app/capabilities/types.ts) | Trusted app identity, bindings, and invocation callback supplied by the kernel. |

In SDK 0.17.0 the dev capability returns unavailable for both agent methods. The existing text transport lacks cancellation and a structured tool-response codec. Its automatic CLI selection checks PATH availability, not authentication or model readiness. Pi text calls already disable tools; the existing Claude invocation needs stronger isolation, and Codex's read-only sandbox alone does not disable tool execution.

## Feasibility proof

A temporary end-to-end test on 2026-09-12 used the installed Claude CLI as the text backend for an in-memory Pi `Agent`. Each subprocess used print mode, an empty built-in tool set, strict MCP configuration, safe mode, and disabled session persistence. The request carried the conversation and a synthetic `lookupFixture` tool schema; a prompt specified the JSON response protocol. Authentication stayed inside Claude.

The first CLI response requested the tool. The internal Pi agent executed it and generated an unpredictable fixture value. A second, fresh CLI invocation received the updated conversation and tool result, then returned that exact value as its final answer. Assertions passed: two model requests, one tool execution, and a matching final answer. This proved the text-provider loop; it did not verify real app permissions, cancellation, or the packaged dev server.

Pi was found first on PATH but its saved login failed to refresh with `invalid_refresh_token`. Claude was usable. This demonstrates why agent backend resolution must check readiness. Pi and Codex still need the same authenticated round-trip proof before their adapters are advertised as supported. The temporary test made no repository code changes.

## Implementation

### 1. Adapt one-shot text into Pi model responses

Wrap the resolved text backend at the existing `AgentBackend` boundary. Implement a shared codec and Pi-compatible `streamFn`; retain `completeFn` where required by that contract. Keep the public `generateText` path unchanged.

- Encode the system prompt, ordered conversation, tool names/descriptions, and parameter schemas into each request. Preserve roles, tool-call IDs, results, and errors. Treat retrieved content as data within the conversation. Each CLI invocation receives the full current context; it never resumes a developer session.
- Use a minimal discriminated JSON response: `{ type: "tool_call", name, arguments }` or `{ type: "final", text }`. Start with one tool call per response, matching the runner's sequential execution. The provider returns a request to use a tool; it never executes that tool.
- Parse and validate the response before emitting Pi content. Map a valid request to a `toolCall` with an adapter-generated unique ID and `stopReason: "toolUse"`; map a final answer to text with `stopReason: "stop"`. Validate names against the supplied tools and arguments against their schemas. Reject malformed or ambiguous output without executing it or replaying the task.
- Where a CLI supports a final-output JSON schema, use it to improve reliability. A CLI's JSON event-output mode alone is not this response protocol; decode its result envelope separately. Never infer tool calls from ordinary prose or execute model-generated shell text.
- A buffered response is sufficient: return Pi's event stream with a terminal message after the subprocess finishes. Encode transport failures and aborts as Pi error/aborted events, following the `StreamFn` contract. Token-by-token streaming is not required for the app API.
- Support the text conversation and tool results needed by Learn first. Preserve the existing app tool's bytes/bigint encoding. Reject unsupported content types clearly instead of silently losing information. Bound input and captured output; do not silently truncate context or claim model metadata the CLI does not expose.

The tradeoffs are subprocess startup on every model turn, repeated context serialization, and model adherence to the JSON protocol. These are acceptable for the initial local workflow; the adapter boundary leaves room for a native model provider later.

### 2. Resolve a usable backend and contain CLI behavior

Keep the public `devAi()` selection forms and existing text behavior. Reuse the candidate order for agent requests, adding a bounded readiness check when the agent backend is first needed. Cache the result for the dev-server lifetime rather than running inference on every GUI refresh.

- In automatic mode, skip unusable candidates with a concise reason, then try the next candidate. In explicit mode, report the selected backend's error. Distinguish missing executable, unsupported flags/mode, login failure, and model/response failure. Keep one selected backend for the active task; do not restart a partially completed task on another backend.
- Confirm version-specific one-shot flags for Pi, Claude Code, and Codex. Disable CLI-owned tools, MCP servers, extensions/plugins, hooks, skills, and project-context loading while retaining authentication and necessary model configuration. Use a neutral temporary working directory and ephemeral invocation. A prompt asking the CLI not to use tools, or a read-only sandbox, is insufficient by itself.
- Begin with the Claude mode exercised by the proof. Verify equivalent Pi and Codex modes rather than assuming the existing text flags provide isolation. If a CLI version cannot supply the required behavior, report it as unavailable for agent requests and continue automatic selection.
- Extend the subprocess/HTTP boundary with abort support without breaking existing text callers. Custom functions need an explicit abort-aware agent path; do not advertise cancellation for an uninterruptible function. Keep HTTP and custom-function support behind the same codec and contract tests, without introducing a second agent loop.
- Package any required local assets with the released SDK. Developers should select an installed backend or supply an existing configuration/function, without a platform checkout or manually managed credentials in app files.

### 3. Share the JustFiles harness and lifecycle

Replace the dev capability stubs with the shared AI capability and delegated runner, supplying the CLI-backed model backend and the dev host's research fetch implementation. Keep one implementation of request admission, tool execution, and lifecycle behavior.

Resolve the package boundary before wiring it: `@justfiles/agent` already depends on `@justfiles/app`. Use the smallest shared runner extraction or separate dev integration package that avoids a reverse dependency cycle. A new subpath export alone does not remove that cycle. Keep CLI process code in the Node dev-server path and out of app/GUI bundles.

- Check the `agent` scope and inputs, and take app metadata from trusted `ctx.app`. Tool invocations use the supplied bindings and `ctx.app.invoke`; the model cannot select another app identity or invent grants. Preserve API-reference discovery, capability argument encoding, and public-page retrieval restrictions.
- Register one active request per app before asynchronous backend setup. Keep execution state in memory, reject overlaps, and retain fresh context for each `runAgent` call. Learn supplies any relevant saved history in its prompt.
- Preserve cancellation by app identity and request ID. Repeated cancellation is safe; unknown, stale, and other-app IDs cannot stop new work. Abort backend setup, model transport, and research. Stop scheduling tools and wait for in-flight capability operations to settle before releasing the slot.
- Preserve the ten-minute deadline and 50-tool-execution limit in the JustFiles runner. The original call resolves with `{ cancelled: true }` for user cancellation; ordinary failures and timeouts reject. Completed capability writes survive failure/cancellation.
- Terminate and reap active subprocesses, including descendants where needed, and clear timers and temporary files in `finally`. Bound diagnostics and return only the completed assistant reply to the app.

### 4. Integrate, document, and release

Wire the provider through the current dev server's capability registration and persistent volume. Add disposal on server shutdown and headless-app reload: stop active work and drain operations before replacing the kernel context. Restarting the server must show saved files with no active requests and must never replay an interrupted call. Preserve normal GUI refresh behavior.

Document selection, supported CLI versions/modes, readiness failures, response/cancellation requirements for custom backends, and the text-protocol tradeoffs. Verify the SDK from an installed tarball in a standalone fixture, then use the normal publication workflow. Learn can upgrade to the exact released version afterwards.

## Verification and acceptance

Use Vitest with fake text/process boundaries for deterministic coverage. Keep authenticated CLI smoke tests explicit and outside unattended unit tests.

- Existing `generateText`, explicit selection, and text discovery/error behavior remain compatible.
- Test the provider's full context encoding and JSON decoding, including multiline/escaped text, tool results/errors, unknown tools, invalid arguments, malformed output, unsupported content, output bounds, and Pi terminal/error events. Invalid responses must cause no tool execution.
- Reproduce the proof with the real Pi agent: a fake or real text backend requests a tool, only Pi executes it, the next model request includes its result, and the final answer uses it. Verify each advertised CLI with its own tools/customizations disabled and its existing login.
- Test automatic selection past an installed but unusable CLI, explicit-backend errors, cached readiness, and cancellation during readiness checks. Do not switch backends or replay a task after tool execution begins.
- Through real app procedure/command dispatch, verify inherited identity and scopes across multiple volume bindings, a folder outside the prompt's suggested output directory, an inherited non-filesystem capability, undeclared-binding rejection, and two apps with different grants.
- Exercise busy handling, cancellation during model/tool execution, stale IDs, timeout/tool limits, and completion races. A slow write must settle before a replacement request can start. No cancelled subprocess response may initiate a later tool call.
- Under the real dev server, research a public source and write a file through an app capability. The GUI reads it through its normal procedure, stays responsive, and exposes Stop. Restart after completion and cancellation to verify persistence, empty execution state, and no replay or orphan processes.
- Run repository checks appropriate to the implementation and verify the published SDK contains the shared runner and provider code without workspace-only imports or a dependency cycle.

Done means a standalone app can research, inspect its data, author files, stop an invocation, and reopen saved results through the released dev host. The developer's CLI supplies model responses and owns authentication; JustFiles' Pi agent owns the task. Learn's lesson formats, prompts, candidate validation, MDX renderer, and publication behavior remain Learn implementation work.


## Implementation verification (2026-09-12)

The implementation lives in the SDK's `capabilities/ai/host.ts`, with the shared
runner under `capabilities/ai/agent/`. Platform hosts retain their learning
projection wrapper. Node transport and public-address fetch are separate from
app and GUI entry points. API references are generated from the contracts and
included in the SDK build, with no dependency on `@justfiles/agent` or a platform
checkout.

Deterministic tests cover the codec and real Pi tool loop, readiness and abort,
identity and scopes through procedures/commands, subprocess descendants, and
dev-server persistence, shutdown, and entry/dependency reload. The existing
harness tests retain the deadline and tool limit checks.

An installed SDK tarball was verified in a standalone fixture with Claude Code
2.1.263 and `ANTHROPIC_MODEL=sonnet`, using the existing login. The GUI stayed
responsive while the agent fetched example.com and wrote its title and source
URL through the app volume. Stop returned cancelled; restarting restored the
file and reducer state without replay. The fixture is in
`packages/app/test-dev-agent/`.

The installed default Opus 5 returned a `reasoning_extraction` safeguard failure
for the readiness conversation. This is reported without starting app work;
saved CLI settings were not changed. Pi 0.84.4 failed OAuth refresh, and Codex
0.153.4 has no verified tool-free mode, so both remain text-only.

Released as `@justfiles/app@0.18.0` through the normal release-please and
`publish-app` workflow. Implementation PR #652 and release PR #653 are merged.
All 2,359 repository tests, local typechecks, Linux CI checks, and the SDK build
passed. The published package was installed in the standalone fixture.

Release: https://github.com/xiaoxinghu/justfiles/releases/tag/app-v0.18.0
