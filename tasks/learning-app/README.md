# Learn — adaptive learning with a tutor in the margin

Design updated 2026-09-11. Implementation has not started. Build Learn in its own repository for Frieren and Just Computer for Mac.

Learn helps someone reach a concrete learning goal across multiple visits. Reading and practice are the main activity; the tutor prepares short materials, answers questions beside the passage, and uses evidence from practice to choose what comes next.

## Design map

| Document | Purpose |
| --- | --- |
| [Mockups](mockups.html) | Library, setup, learning, and next-step visual direction |
| [User flows](user-flows.md) | Interaction and restart behavior |
| [Data model](data-model.md) | Files, reducer state, ownership, and operations |
| [Materials and agent execution](material-rendering.md) | MDX isolation and the runAgent workflow |
| [Execution plan](execution-plan.md) | Standalone implementation and acceptance checks |

Written behavior governs incidental controls and example text in the mockups.

## Product decisions

- **Generate as learning progresses.** Confirm a mission and starting point, then prepare one useful lesson. There is no complete course upfront or percentage of an imagined syllabus.
- **Keep the app compact.** Use @justfiles/design: system typography, compact toolbars, resizable panes, and a quiet reading surface. The host supplies window chrome. Questions and notes live in the margin.
- **Distinguish learning from lookup.** A learning workspace is a gallery item and goal folder, called a “topic” in the mockups. A lesson is one tutorial with practice under lessons/; a reference is reusable lookup material under reference/. Both are MDX materials with stable IDs.
- **Keep one current source.** Adaptation mainly changes the next lesson. Occasional corrections edit materials in place; there is no lesson revision archive. Preserve annotations whose passages change.
- **Save useful work.** Files hold materials, answers, notes, conversations, and learning evidence. Reducer state holds only the current workspace and material paths. Never persist a running request or restart one on launch.
- **Keep memory visible.** Tutor observations cite evidence and can be corrected. Completion records activity; it does not establish mastery. Learner notes remain separate from tutor notes.

The [teach skill](https://www.aihero.dev/skills-teach) supplies the underlying loop: clarify a relevant goal, research trustworthy sources, teach a small step, observe practice, record evidence, and adapt. The files preserve this continuity without requiring a long-lived AI conversation.

## Platform assumptions

For this design, assume these improvements are implemented, available in the dev server, and released in the SDK:

| Platform support | What Learn relies on |
| --- | --- |
| ai.runAgent and ai.cancelAgent | Fresh agent tasks with research tools, scoped file access, a final response, and cancellation. |
| Persistent dev storage | Project-local .justfiles/dev/ survives reloads/restarts and supports external file edits. Keep it gitignored. |
| Shared GUI runtime | Development uses the same built GUI, sandbox, CSP, and module-loading behavior as Frieren and Mac. |

These are planning assumptions, not a claim that a particular published version has been verified. Use a released SDK/template containing all three. Learn owns its teaching prompts, file formats, renderer, and validation; it adds no platform APIs.

Routine development is self-contained. Headless runtimes and native integration still differ, so avoid host-specific code and smoke-test installed builds near release.

## First-release boundary

Include workspace CRUD, conversational setup, sourced lesson generation, references, practice, margin notes/Q&A, resume, visible memory, and reviews shown during app use. Defer full course planning, durable agent sessions/jobs, background reminders, version history, global learner profiles, collaboration, and component marketplaces.
