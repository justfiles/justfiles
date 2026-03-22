---
name: enrich
description: Run the enrichment pipeline on all inbox notes — categorize each note (assign path + tags), find related notes, and decide ADD/UPDATE/SKIP/LINK/CONFLICT.
argument-hint: (no arguments needed)
allowed-tools: mcp__ghostore__list_memories, mcp__ghostore__search_memory, mcp__ghostore__get_memory, mcp__ghostore__write_memory, mcp__ghostore__update_memory, mcp__ghostore__archive_memory
---

Process all inbox notes through the enrichment pipeline.

## Step 1 — Find inbox notes

Call `mcp__ghostore__list_memories` with:
- `path_prefix`: `"inbox"`
- `limit`: 50

If no results, report "inbox is empty — nothing to enrich" and stop.

## Step 2 — For each inbox note, run the pipeline

Call `mcp__ghostore__get_memory` with the note's ID to fetch full content. Process one note at a time.

### 2a. Categorize

Read the note content and assign:

**Path** — slash-delimited, lowercase, hyphen-separated:
- If the note is specific to a project: `<project>/<optional-subtopic>` (e.g. `ghostore/auth`)
- If it's general knowledge not tied to a project: `notes/<topic>` (e.g. `notes/react`)
- Depth: 1–3 segments

**Tags** — 1–4 lowercase cross-cutting labels:
- Choose from: `decision`, `context`, `reference`, `idea`, `question`, `insight`, `summary`, `log`, `to-process`, `resource`, `pattern`

### 2b. Connect

Call `mcp__ghostore__search_memory` with the first ~80 words of the note as the query, `limit: 10`. Exclude the current note from results.

Call `mcp__ghostore__get_memory` for any result with score > 0.5 to read full content.

Make exactly one decision:

| Decision | Condition |
|----------|-----------|
| **ADD** | No meaningful overlap — genuinely new. |
| **UPDATE** | A candidate covers the same topic but this note is more complete or accurate. |
| **SKIP** | Redundant — an existing note already captures this adequately. |
| **LINK** | Related but distinct and complementary — both should exist. |
| **CONFLICT** | Contradicts an existing note on a factual or opinion claim. |

### 2c. Execute

- **ADD**: Call `mcp__ghostore__update_memory` on the inbox note with the assigned `path` and `tags`. This relocates it in place without hitting the dedup gate.

- **UPDATE**: Merge the inbox note's content into the candidate's. Call `mcp__ghostore__update_memory` on the *candidate* note with the merged `text`. Then call `mcp__ghostore__archive_memory` on the inbox note to remove it from the active set.

- **SKIP**: Call `mcp__ghostore__archive_memory` on the inbox note — it's redundant, no filing needed.

- **LINK**: Call `mcp__ghostore__update_memory` on the inbox note with the assigned `path` and `tags`. Note the relationship in the final summary (linking will be handled once `link_memories` is available).

- **CONFLICT**: Call `mcp__ghostore__update_memory` on the inbox note with the assigned `path` and `tags`. Then call `mcp__ghostore__write_memory` to create a new conflict proposal at `proposals/<timestamp>`:
  ```
  CONFLICT PROPOSAL
  new_note_id: <id>
  existing_note_id: <id>
  conflict_summary: <1-2 sentences>
  ```
  With `tags: ["proposal", "conflict"]`, `source: "agent"`.

## Step 3 — Report

```
Enrichment complete: <n> notes processed

  added:     <n>
  updated:   <n>
  skipped:   <n>
  linked:    <n>
  linked:    <n>  ← links pending link_memories tool
  conflicts: <n>  ← run /review-proposals to resolve
```
