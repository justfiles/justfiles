---
title: AI capability
description: Generate text or delegate an awaited task with optional workspace access.
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
	prompt: 'Research the options, cite your sources, and write a report to /report.md.',
	workspace: { capability: 'files', path: '/research' }
})

// A separate Stop procedure forwards the same ID:
const recorded = await app.cap.ai.cancelAgent({ requestId })
```

`runAgent` returns `{ text: string }` when finished or `{ cancelled: true }` after cancellation has stopped execution and released resources. `cancelAgent` returns true for the calling app's matching active request when cancellation is recorded. Repeating it is safe; unknown or completed IDs return false. IDs address cancellation only. They cannot retrieve results or resume a conversation, and must not be reused.

Each invocation starts with fresh messages and the prompt supplied by the app. It can search the web and read public HTTP(S) pages. Page requests use GET, exclude credentials, and check redirects. Without `workspace`, it has no filesystem tools. With a workspace, the selected declared volume binding and path become `/` for a volume-backed shell. Missing directories are created. The host resolves the binding from the executing app's declarations; request arguments cannot grant scopes. Symlink traversal is disabled, including links in the selected root. Credential storage remains inaccessible even through a system volume grant.

Delegated agents do not inherit human chat, user memory, privileged app or OS commands, account tools, or `ask_user`. Include the context, constraints and desired output in `prompt`. The app collects any missing information before invoking another task.

One delegated request may be active per app. Overlap, model failures, and the fixed limits of ten minutes or 50 tool executions reject with `CAPABILITY_FAILED`; missing scopes or workspace grants use `CAPABILITY_DENIED`, invalid arguments use `CAPABILITY_INVALID_INPUT`, and unavailable backends use `CAPABILITY_UNAVAILABLE`. `devAi()` remains text-only and reports unavailable for both agent methods. Human chat and `generateText` remain independent of this slot.

Writes completed before cancellation or failure survive. Multi-file authoring is not transactional; the app validates its artifacts. A host restart or connection loss never replays the request, and background completion is not promised. Save any final answer the app needs: the platform retains no result history.

## Host integration and release

Frieren resolves the selected credentialed backend through its existing metering path and retains the pending execution in the Durable Object. Mac resolves it through `accounts.resolveBackend()` and checks the DNS address used by each research connection. Both hosts use the same runner and request lifecycle.

The SDK follows the existing release-please process: merge the feature to main, merge the generated App/FS release PR, and let the package tag workflows publish. Do not publish the existing SDK version or create an independent version bump for this feature.
