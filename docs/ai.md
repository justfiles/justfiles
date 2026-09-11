---
title: AI capability
description: Generate text or delegate an awaited task with the calling app’s capabilities.
---

# AI capability

`@justfiles/app/capabilities/ai` exposes `generateText`, `runAgent`, and `cancelAgent`. Text generation keeps its existing behavior. Delegated tasks require the `agent` scope:

```ts
import { ai } from '@justfiles/app/capabilities/ai'
import { volume } from '@justfiles/app/capabilities/volume'

const capabilities = {
	ai: ai({ scopes: ['agent'] }),
	files: volume({ scopes: ['app'] })
}
```

Call these methods inside app procedures. The GUI creates a fresh request ID, holds it while awaiting the procedure, shows its own Working indicator, and calls a second procedure for Stop. Keep this temporary state in the GUI rather than persisting a running flag in app state.

```ts
const result = await app.cap.ai.runAgent({
	requestId,
	prompt: 'Research the options and write /research/report.md in files. Look at other folders for examples, and cite your sources.'
})

// A separate Stop procedure forwards the same ID:
const recorded = await app.cap.ai.cancelAgent({ requestId })
```

`runAgent` returns `{ text: string }` when finished or `{ cancelled: true }` after cancellation has stopped execution and released resources. `cancelAgent` returns true for the calling app's matching active request when cancellation is recorded. Repeating it is safe; unknown or completed IDs return false. IDs address cancellation only. They cannot retrieve results or resume a conversation, and must not be reused.

Each invocation starts with fresh messages and the prompt supplied by the app. It inherits all of the app’s declared capability bindings. The agent’s capability tool can read each API reference and invoke its methods, using the same app identity, scopes, and implementations as an ordinary app call. Calls return to the executing kernel even when the model runs remotely, so browser-local files and capabilities stay local. Request arguments cannot supply permissions.

There is no workspace argument or additional filesystem policy. A path in the prompt guides the task; the agent can explore other paths and volume bindings available to the app. For example, it can read another workspace as a template before writing the requested report. File writes use the existing volume capability, including its parent-directory creation behavior.

The runner also offers web search and public HTTP(S) page reading. Page requests use GET, exclude credentials, and check redirects. Human chat and global memory are not automatically loaded. Include relevant context and desired output in the prompt; the app collects missing information before another invocation.

One delegated request may be active per app. Overlap, model failures, and the fixed limits of ten minutes or 50 tool executions reject with `CAPABILITY_FAILED`; missing scopes use `CAPABILITY_DENIED`, invalid arguments use `CAPABILITY_INVALID_INPUT`, and unavailable backends use `CAPABILITY_UNAVAILABLE`. `devAi()` remains text-only and reports unavailable for both agent methods. Human chat and `generateText` remain independent of this slot.

Cancellation stops further tool calls and waits for an active capability operation to settle before releasing the request. An operation already underway may finish its write. Completed writes survive cancellation or failure. Multi-file authoring is not transactional; the app validates its artifacts. A host restart or connection loss never replays the request, and background completion is not promised. Save any final answer the app needs: the platform retains no result history.

## Host integration and release

Frieren resolves the selected credentialed backend through its existing metering path and retains the pending execution in the Durable Object. Mac resolves it through `accounts.resolveBackend()` and checks the DNS address used by each research connection. Both hosts use the same runner and request lifecycle.

The SDK follows the existing release-please process: merge the feature to main, merge the generated App release PR, and let the package tag workflows publish. Do not publish the existing SDK version or create an independent version bump for this feature.
