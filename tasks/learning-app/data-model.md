# Learn — data and operations

## State boundary

The persisted reducer has exactly two fields:

~~~json
{
	"lessonPath": "/learning/rust-cli",
	"materialPath": "lessons/0003-borrowing/content.mdx"
}
~~~

Both initially equal null. Despite its historical name, lessonPath identifies the learning workspace. No workspace means library; a workspace without material means overview. References use the same materialPath field.

Validate canonical workspace paths under /learning and relative material paths confined to that workspace. Clearing/changing the workspace clears or replaces the material in the same transition. Reconcile missing files on launch; report corrupt metadata without deleting it. The kernel persists this state; do not add another app-state file.

Everything else has one home:

| Location | Contents |
| --- | --- |
| Learning volume | Materials, progress, conversations, meaningful drafts, and learning memory. |
| App-private volume | Unconfirmed setup brief and completed setup messages. |
| GUI/procedure memory | Request IDs, busy/error state, cancellation, selection geometry, expanded threads, and loaded/derived views. |
| Rebuildable cache | Compiled material output, keyed by current inputs/runtime version. |

No persisted route kind, active thread, job status, pending question, or refresh counter. A submitted question is history, not pending execution.

## Folder structure

~~~text
/learning/rust-cli/
├── workspace.json
├── MISSION.md
├── RESOURCES.md
├── NOTES.md
├── learning-records/
│   └── 0002-borrow-scope-needs-practice.md
├── lessons/
│   └── 0003-borrowing/
│       ├── content.mdx
│       ├── lesson.json
│       ├── attempts.jsonl
│       └── assets/BorrowDiagram.jsx
├── reference/
│   └── ownership-cheat-sheet.mdx
├── assets/
│   ├── components/
│   └── media/
├── annotations/lesson-borrowing.json
├── conversations/
│   ├── workspace.jsonl
│   ├── lesson-borrowing.jsonl
│   └── reference-ownership.jsonl
├── drafts/
│   ├── lesson-borrowing.json
│   └── generated/<draft-id>/
├── notebook/my-ownership-analogy.md
├── reviews.json
└── .cache/
~~~

Create optional paths lazily. A confirmed workspace starts with metadata, mission, and existing setup facts. Lesson numbers indicate creation order, not a fixed curriculum. Keep one current material source; drafts and compilation caches are not revision archives.

Declare a volume binding named learning, scoped to /learning, and a second private binding for setup. Convert public workspace paths to binding-relative paths at one boundary. Neither app code nor generated material accesses host disk directly. In development, these volumes live in the dev server's ignored .justfiles/dev/ storage.

## File contracts

IDs are stable, path-safe strings. Each MDX file has authoritative id and title frontmatter; renames preserve the ID. Detect duplicates instead of guessing associations. Resolve IDs from the material list without a separate durable registry.

| File | Minimum contents |
| --- | --- |
| `workspace.json` | `id`, `title`, `createdAt`, nullable `archivedAt`, `resumeMaterialPath`, and `nextStep`. A next step has `title`, `reason`, and evidence links; it can be null. |
| `lesson.json` | `createdAt`, nullable `startedAt`/`completedAt`, `resume.blockId`, and `exercises` keyed by stable exercise ID, each with draft `answer`, `hintsUsed`, and bounded JSON `widgetState`. |
| `attempts.jsonl` | Submission records with `id`, `exerciseId`, `at`, `answer`, and `hintsUsed`. Later feedback is a separate record referencing the attempt and identifying deterministic/tutor feedback. |
| `annotations/<material-id>.json` | Array of notes/highlights described below. |
| `conversations/<material-id>.jsonl` | Messages with `id`, local `threadId`, `role`, `at`, `text`, and optional annotation/exercise target. `workspace.jsonl` holds setup/general discussion. |
| `drafts/<material-id>.json` | Unfinished question/note text and its anchor/thread target. Exercise drafts remain in `lesson.json`. |
| `reviews.json` | Review items with `id`, `materialId`, optional anchor, `prompt`, `reason`, evidence, `dueAt`, optional `dismissedAt`/`draftAnswer`, and completed attempts recording time, answer, assistance, and outcome. |

The goal lives in MISSION.md, not duplicated in metadata. The workspace's study checkpoint is separate from global navigation: looking up a reference leaves resumeMaterialPath unchanged. References need no lesson-progress sidecar. Stable submission/message IDs prevent retry duplicates. Completion is explicit; “due” is computed from dates.

An annotation contains id, author: learner, creation/update times, Markdown body, and an anchor with blockId, exact quote, prefix, and suffix. Empty body means highlight. Optional normalized text offsets disambiguate repeated quotes; DOM rectangles remain local. Preserve block IDs during corrections. Ambiguous/missing matches remain visible for manual reattachment.

Material-local threadId groups related questions; it is never a platform session ID. Each agent invocation reconstructs relevant history from files. Keep completed user-facing replies, not tool traces or partial tokens. Unanswered questions do not automatically retry.

## Memory and ownership

Keep the [teach skill conventions](https://github.com/mattpocock/skills/blob/main/skills/productivity/teach/SKILL.md):

| File | Meaning and ownership |
| --- | --- |
| MISSION.md | Goal, success criteria, starting point, constraints. Tutor proposes; learner confirms changes. |
| RESOURCES.md | Curated source links and why they matter. Tutor researches; learner can contribute. |
| NOTES.md | Inspectable teaching preferences and uncertain observations. Learner can correct them. |
| learning-records/*.md | Evidence-backed understanding or misconceptions, linked to attempts/messages. Contradictory evidence can supersede a record. |
| notebook/*.md and annotations | Learner-authored notes; the tutor does not overwrite them. |
| reviews.json | Review proposals and actual outcomes, using a small documented scheduling policy. |

There is no hidden memory store or global learner profile. Learning-record history preserves evidence, not old lesson versions.

The agent writes candidate teaching files only inside `drafts/generated/<draft-id>/`, with paths mirroring their intended destinations. Learn supplies relevant context and validates/adopts candidate output. Progress, learner notes, conversations, and navigation stay app-owned. A draft ID names recoverable content; it is separate from an ephemeral agent request ID. Delete successful drafts instead of accumulating versions.

## Operations and consistency

Expose validated semantic operations for workspace management/navigation, reading context, saving annotations/exercises, submitting attempts/questions, preparing/publishing materials, and reviewing/correcting learning evidence. Keep the interface small; reuse plain file reads for inspection rather than wrapping every field. Do not expose arbitrary reducer patches.

GUI procedures and the app's interactive agent can use these operations. A delegated runAgent task has research/filesystem tools, not implicit access to Learn's procedures. Its narrower draft grant and Learn's publication step enforce the same data ownership.

Questions capture material ID/path and quote/exercise at submission. Context assembly reads the mission, relevant material/references, evidence, and selected conversation; it cannot infer an unsent selection. Saving a reply/material does not implicitly navigate.

Serialize conflicting app read-modify-write operations and check expected file contents before replacing externally editable files. A hash detects stale writes/cache inputs without retaining historical copies. A reducer queue alone does not serialize procedures. Acknowledge only successful writes; do not promise a cross-file transaction.

Autosave drafts while typing, flush before controlled navigation, and retain unsaved buffers on errors. Transfer private setup data only after the confirmed destination saves. Rename/removal updates affected navigation while stable IDs preserve associations.

Refresh visible files on mount, material change, focus, and completed mutations. Use the supported file-change channel where sufficient, or bounded foreground metadata polling; no persisted invalidation signal. Reopening derives the GUI from current files and the two paths, with all execution state empty.
