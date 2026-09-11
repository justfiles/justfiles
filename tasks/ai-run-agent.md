---
project: platform/ai
status: todo
---

# AI capability: run a delegated task

Let any app delegate a task to an agent with fresh context, research tools, and optional workspace access. Examples include researching a purchase, organizing documents, or preparing a report. The app supplies instructions; the platform runs tools and returns the result. Keep `generateText` unchanged.

## What existing harnesses teach us

Primary documentation/source checked 2026-09-11:

| Harness | Interface pattern | What to borrow |
| --- | --- | --- |
| [Codex](https://learn.chatgpt.com/docs/agent-configuration/subagents) | Starts agents, routes follow-ups, waits for results, and closes threads; children inherit sandbox policy. | Delegated authority and separate context. Its full orchestration surface can wait. |
| [Claude Code](https://code.claude.com/docs/en/sub-agents) | Supports foreground calls that return when finished and background agents with later completion notifications. Non-fork subagents start with their own context. | A foreground task is useful independently of background/session management. |
| [OpenCode Task tool](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/task.ts) | Foreground is the default; the call awaits the result and connects caller abort to task cancellation. Background execution is separately gated. | Start with an awaitable operation and cancellation. |
| [Pi subagent example](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/subagent/index.ts) | A single invocation takes an agent/task/cwd, awaits its result, and propagates cancellation. Its subprocess uses `--no-session`. This is an example extension, not a built-in subagent API. | Fresh execution, final output, and explicit cancellation; no mandatory durable conversation. |

**Decision:** adopt the foreground pattern. An awaited Promise leaves the GUI responsive. Background admission, polling, retained results, and a run-status API are unnecessary for v1.

## Minimal public interface

Add two methods alongside `generateText`:

```ts
runAgent(input: {
	requestId: string
	prompt: string
	workspace?: { capability: string; path: string }
}): Promise<{ text: string } | { cancelled: true }>

cancelAgent(input: { requestId: string }): Promise<boolean>
```

- `runAgent` resolves when execution finishes. The result is final text; files are written directly to the workspace. Failures reject with existing capability errors.
- The caller generates a fresh `requestId` and keeps it only while awaiting the call. It exists to address cancellation across RPC, where an `AbortSignal` is not currently transported. It is not a session ID or a result lookup handle.
- `cancelAgent` returns true when it records cancellation for that app's matching active request, false otherwise. The original call resolves with `{ cancelled: true }` after execution stops. Repeated cancellation is safe; stale IDs cannot stop newer work.
- `prompt` contains the task, constraints, relevant context, and desired output. No model picker, role registry, domain-specific context selector, or separate instruction schema is needed.
- `workspace.capability` names a declared volume binding; `path` is inside that binding. For example, `{ capability: 'files', path: '/report' }` makes that folder the agent's filesystem root. Without a workspace, offer research tools only.
- The host derives app identity and requires the `agent` AI scope. Allow one active delegated request per app initially; reject overlapping requests. Human chat remains separate.

The GUI shows its own “Working” indicator while awaiting an app procedure and exposes Stop through a second procedure. Neither procedure persists running state. Detailed activity and streaming can follow later.

## Execution and access

Implement one small runner in `packages/agent`, using [createAgent](../packages/agent/llm.agent.ts), the existing credentialed backend, search/page-reading tools, and [volume-backed bash](../packages/agent/justbash/index.ts). Use fresh messages per invocation. Do not drive or reset the persistent `agents.app(appId)` conversation.

Workspace authority comes from the calling app's existing volume declaration. Resolve the selected binding through the [executing kernel's resolver](../packages/app/kernel.capability.ts), carry its trusted grant through remote capability RPC, and reuse [resolveVolume](../packages/app/capabilities/volume/host.ts). Pass only the selected grant as host metadata; no new permission store or full binding catalog is needed. Request arguments cannot supply scopes. Narrow all file operations to that workspace, including symlink resolution; a working directory alone is not confinement.

Wrap existing fetch as public HTTP(S) read-only retrieval, including redirects; its raw request options are broader. Preserve credential exclusions. Do not automatically inherit privileged host app/OS commands, account tools, global memory, or `ask_user`. Apps collect missing information and invoke another task when needed.

Track only active requests and abort handles in memory; register before asynchronous setup and remove in `finally`. Propagate cancellation through setup, model calls, tools, and file operations. Release volume watches—the current [filesystem adapter](../packages/agent/justbash/volume-fs.ts) does not expose its watch cleanup. Keep the slot until tool work has stopped. Use fixed host limits initially: ten minutes and 50 tool executions; exceeding either fails the call.

Completed writes survive cancellation/failure; multi-file authoring is not transactional. The app validates its own artifacts. Host restart or connection loss never automatically replays a request, and no background completion is promised. The caller saves any final answer it needs; the platform retains no result history.

## Implementation plan

1. **Prove the awaited path.** Use a scripted multi-step backend through the real app procedure and capability RPC on Frieren and Mac. Verify the GUI remains responsive, cancellation works during setup/tools, and the host owns the pending execution. Existing [procedures run outside the reducer queue](../packages/app/kernel.ts); verify remote lifetime rather than adding a detached job manager.
2. **Add contract and scoped runner.** Extend [AiCapability](../packages/app/capabilities/ai/contract.ts) and [aiCapability](../packages/agent/ai.capability.ts). Pass the selected workspace grant from the executing kernel in both procedure and command paths. Add cancellation, limits, and tool cleanup. Keep account-provider bindings typed to their existing text operation rather than making providers implement orchestration.
3. **Wire hosts.** Reuse Frieren's backend selection/metering and Mac's `accounts.resolveBackend()`. Both methods share the same active-request map. Text-only `devAi()` backends explicitly return unavailable for agent execution; an optional adapter over the same dev volume is a follow-up.
4. **Verify and publish.** Test research-to-file output, no-workspace research, app/path isolation, busy handling, early/late cancellation, errors/limits, watcher cleanup, and unchanged text/chat behavior. Smoke-test both hosts, document the two methods, and release the SDK through the normal process.

## Later, when a consumer needs it

Add streaming progress, background handles, follow-up messages, concurrent runs, or configurable tools/model individually. Do not expose recursive delegation, agent teams, durable sessions, or scheduling in v1. Domain workflows and file layouts remain app instructions.

**Expected size:** a contained platform addition. The main work is scoped workspace delegation, cancellation across existing transports, and resource cleanup; the model loop and tools already exist. Documentation only at this stage.
