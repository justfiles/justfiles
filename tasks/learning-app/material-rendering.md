# Learn — materials and agent execution

## Use the AI capability directly

Use `ai.runAgent` for research, lesson/reference authoring, tutoring, and evidence-based follow-up. Keep `generateText` available for simple text-only utilities; it is not the lesson-generation interface. Declare the AI `agent` scope and the learning/private volume bindings.

The [agreed platform contract](https://github.com/xiaoxinghu/justfiles/blob/main/tasks/ai-run-agent.md) is:

~~~ts
runAgent(input: {
	requestId: string
	prompt: string
	workspace?: { capability: string; path: string }
}): Promise<{ text: string } | { cancelled: true }>

cancelAgent(input: { requestId: string }): Promise<boolean>
~~~

Use the published SDK's types when implementing. Each invocation starts fresh, runs research tools and optionally filesystem tools, and returns final text. There is no session, streaming, tool-progress feed, durable run handle, or polling API. One delegated run per app is allowed initially; keep reading/notes available and disable additional tutor submissions while busy. Handle a platform busy error without adding a queue.

The GUI creates a request ID and passes it to an app procedure. That procedure calls runAgent; a separate Stop procedure calls cancelAgent. Keep IDs and active-call bookkeeping in memory only. The request ID addresses cancellation, not a material conversation or saved draft.

## Context replaces a long session

Learn owns short teaching instructions derived from the teach process. Include the task, confirmed mission, relevant material/reference excerpts, source links, learner attempts and assistance, pertinent learning records/tutor notes, and the selected quote or exercise. Add only relevant messages from that material's local conversation. Bound context by relevance instead of sending the entire folder on every question.

| Task | Execution |
| --- | --- |
| Clarify setup | Fresh call with the saved brief/history. Return questions and a brief proposal for the GUI to display/edit. No shared workspace before confirmation; file proposals, if needed, use a private draft. |
| Ask about a passage | Usually omit workspace: research plus the supplied context is enough. Save the final reply to the original material conversation. |
| Prepare a lesson/reference | Grant a candidate folder. The agent researches sources and writes actual MDX, local assets, citations, and proposed learning documents. |
| Interpret practice / suggest next step | Include the saved attempt and relevant evidence. Use a candidate folder when proposing memory/reference changes; never infer mastery merely from completion. |

The app collects missing information; do not assume the delegated agent has an interactive ask_user tool. Follow-ups are new calls with updated files/history. No separate tutor backend, embedded coding harness, or platform conversation API is needed.

## Research and file authoring

Keep the existing draft-before-publication boundary concrete:

1. Save the initiating question/attempt/confirmed mission. Allocate a fresh candidate directory under the workspace's drafts/generated/ and capture current content preconditions for files that might be replaced.
2. Call `runAgent` with that directory as its only writable workspace. For binding `learning` rooted at `/learning`, a candidate under `/learning/rust-cli/drafts/generated/draft-17` uses `{ capability: 'learning', path: '/rust-cli/drafts/generated/draft-17' }`. Supply existing context in the prompt; the grant does not expose the rest of the learning folder.
3. Instruct the agent to write one requested lesson, its assets/citations, and any relevant reference/memory proposals using paths matching the final layout. It must distinguish retrieved evidence from inference. The final text explains the output; it does not carry a giant JSON encoding of every file.
4. Validate allowed output paths, schemas, unique material/block/exercise IDs, imports/assets, compilation, and rendering. Apply expected-content checks for existing files. Report actionable diagnostics for repair; malformed output leaves current materials intact.
5. After the call returns, the still-active GUI requests publication through an app procedure. Move validated new material into lessons/, create app-owned progress metadata, and conditionally apply validated reference/memory changes. Never copy candidate progress, annotations, or conversation files over authoritative data. Mission changes require learner confirmation.
6. Save the completed reply and surface adopted materials/notes. Remove consumed drafts. Navigation changes only if the initiating flow still owns the view.

Routine publication needs no extra approval. Draft folders contain recoverable artifacts, not a job state machine or version archive. A new lesson directory can be published with a filesystem rename; updates across several files are not collectively transactional. Preserve unapplied output when an update conflicts.

Stop invalidates the local request before asking the host to cancel. Do not reuse/delete its writable directory while execution might still write there. Failed or cancelled runs can leave files; they remain candidates. Graceful close attempts cancellation, but abrupt disconnects cannot guarantee it. Agent execution never publishes directly into current materials. The return of runAgent alone does not trigger unattended publication after the GUI closes.

On reopen, offer useful draft content for inspection, explicit retry, or discard. Revalidate against current files before adopting recovered output. Never restore a spinner, infer an active run from a folder, or replay a request automatically.

## MDX source and isolation

Both lessons/*/content.mdx and reference/*.mdx contain Markdown plus React teaching components. Every material has stable id/title frontmatter; prose blocks and exercises have stable IDs for annotations/progress. Supply a small standard set such as Recall and Hint. Custom demonstrations can live beside the material; fixed app-provided dependencies avoid installing packages per lesson.

[MDX compiles to JavaScript](https://mdxjs.com/docs/what-is-mdx/); it does not provide bundling or isolation. Compile/bundle with app-packaged tools, controlled plugins, and bounded local imports. Emit module output and execute it only in the material frame; do not use eval/Function or MDX run/evaluate in the app/host document.

The document boundary is:

~~~text
Shared platform GUI frame
└── Learn: navigation, margin, storage/tutor procedures
    └── Sandboxed material iframe: prose, React, exercises
~~~

The inner frame permits scripts without same-origin permission. It receives the teaching runtime, @justfiles/design styles, lesson typography, serializable theme values, and saved exercise state. Generated CSS stays inside it. Generated code receives no app client, credentials, volume, agent tools, or parent DOM access.

A narrow validated message bridge carries ready/errors, selected quote/geometry, reading checkpoints, exercise drafts/submissions/hints, and link intents. Bind it to the current frame/material and registered IDs; bound payloads and reject stale messages after unmount. Shared React components execute inside the frame. Keep semantic DOM for text anchors and accessibility, and provide textual alternatives for custom visualizations. External links use the host's supported mechanism.

Use the shared runtime's supported nested-document/module path and CSP in the dev server. It reproduces the relevant GUI constraints; Learn should not introduce a host-specific bypass. Cache compiled output by source/dependency content and runtime version. Rebuild caches as needed; saved material and local assets remain readable offline. Keep an app-owned close/reload control for a broken widget: a document sandbox does not guarantee CPU isolation.
