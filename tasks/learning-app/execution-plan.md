# Learn — execution plan

Status: not started. Build in a dedicated repository using the [product decisions](README.md), [flows](user-flows.md), [data model](data-model.md), and [agent/rendering contract](material-rendering.md). Platform improvements are prerequisites assumed complete, not Learn implementation tasks.

## Prepare the standalone repo

- [ ] Use the published @justfiles/create-app React template with an agreed app ID. Pin released SDK/design dependencies supporting runAgent, persistent dev storage, and shared GUI runtime.
- [ ] Follow that template's authoring instructions and scripts. Use pnpm, Node, Vitest, and tabs. Keep dependencies/configuration self-contained; no monorepo workspace:/catalog: references, platform checkout, or platform environment files.
- [ ] Configure the supported dev agent backend. Keep credentials and .justfiles/dev/ ignored. Include a small authored fixture workspace with an MDX exercise and reference.

## 1. Files, library, and reader

- [ ] Implement the two-path reducer, volume bindings, workspace CRUD, material listing, and stale-path recovery.
- [ ] Build the library/overview and three-pane reader with shared design controls.
- [ ] Package the MDX compiler/runtime, fixed dependencies, isolated material frame, and validated bridge. Start with prose, code/tables, Recall, and Hint.
- [ ] Save reading checkpoints and exercise drafts; record submissions and completion separately.

**Acceptance:** create/open a fixture, practise, look up a reference, restart the dev server, and recover saved work. Verify nested rendering under the shared CSP, offline reading, bad-source recovery, and stale frame messages. This tests Learn's renderer locally; it does not require a platform integration project first.

## 2. Setup and agent-generated teaching

- [ ] Build private setup drafts, clarification, editable brief, and confirmed folder creation.
- [ ] Implement bounded context assembly and runAgent/cancelAgent through app procedures, with runtime-only request IDs.
- [ ] Let the agent research and write one lesson plus useful reference/memory proposals into a scoped draft folder.
- [ ] Validate output and publish through the app; handle stale file contents, malformed MDX, cancellation, partial files, and recoverable drafts.

**Acceptance:** start a goal, confirm it, receive a sourced interactive lesson, and request a next step based on an actual attempt. Stop/close during generation and reopen without a false running state or automatic retry. An agent cannot write learner notes through its draft grant.

## 3. Margin notes and contextual questions

- [ ] Add highlight/note/ask actions, stable text anchors, composer autosave, and personal notes.
- [ ] Store material-local conversations; reconstruct context for every fresh call. Save submissions before invoking the agent and deduplicate retries.
- [ ] Preserve changed-passage notes and refresh visible data after app/agent/external file changes.

**Acceptance:** ask about a passage, switch to a reference, then return to the correct history. A late answer stays with its original material. External edits neither silently clobber notes nor attach them to unrelated text.

## 4. Adaptive follow-up and release

- [ ] Add inspectable/correctable tutor notes, evidence-linked learning records, and a saved next-step suggestion.
- [ ] Add due reviews with saved answers, assistance/outcomes, and a simple documented scheduling policy. No background jobs.
- [ ] Check keyboard/focus behavior, narrow layouts, dark mode, and the supplied mockups. Build/install through the normal app packaging path.
- [ ] Near release, smoke-test create → learn → annotate → reference → quit → resume → review in Frieren and the actual Mac host. Check native shortcuts, links, and persistence.

Use focused tests for path confinement, publication conflicts, restart behavior, annotation resolution, request targets, and review scheduling; browser checks for actual rendering/interaction. Run the standalone repository's required checks and build for code changes. Headless/native differences justify release smoke tests, not a platform checkout for everyday work.

Keep storage functions and reducer lean; contain complexity in the renderer and tutor workflow. Do not add sessions, queues, a generic workflow engine, or lesson versioning to implement these steps.
