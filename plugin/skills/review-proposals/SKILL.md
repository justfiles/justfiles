---
name: review-proposals
description: Surface pending conflict proposals and guide the user through resolving each one — accept new, keep old, merge, or flag.
argument-hint: (no arguments needed)
allowed-tools: mcp__ghostore__list_memories, mcp__ghostore__get_memory, mcp__ghostore__update_memory, mcp__ghostore__capture_memory
---

Guide the user through reviewing and resolving conflict proposals.

Conflict proposals are created by `/enrich` when a new note contradicts an existing one. Run `/enrich` first if the inbox has unprocessed notes.

## Step 1 — Find pending proposals

Call `mcp__ghostore__list_memories` with:
- `tags`: `"proposal"`
- `limit`: 50

If none found, report "no pending proposals — knowledge base is clean" and stop.

## Step 2 — Present each proposal

For each proposal, call `mcp__ghostore__get_memory` on the proposal ID, then on both `new_note_id` and `existing_note_id` from its content.

Display:

```
─── Proposal <n> of <total> ──────────────────────────────
Conflict: <conflict_summary>

EXISTING NOTE  (<existing_note_id> at <path>)
<full content>

NEW NOTE  (<new_note_id> at <path>)
<full content>

Resolve:
  [A] Accept new    — replace existing with new note
  [K] Keep old      — discard new note, existing stays
  [M] Merge         — combine both (you'll guide the merge)
  [F] Flag          — mark for later, skip for now
──────────────────────────────────────────────────────────
```

Ask: "How would you like to resolve this? (A/K/M/F)"

## Step 3 — Execute

- **A**: Call `mcp__ghostore__update_memory` on the existing note with the new note's `text`. Then call `mcp__ghostore__update_memory` on both the new note and the proposal with `path: "archived/<timestamp>"`.
- **K**: Call `mcp__ghostore__update_memory` on the new note and the proposal with `path: "archived/<timestamp>"`.
- **M**: Ask the user what to keep from each. Draft merged content, show for confirmation, then call `mcp__ghostore__update_memory` on the existing note with the merged `text`. Archive the new note and proposal with `path: "archived/<timestamp>"`.
- **F**: Call `mcp__ghostore__update_memory` on the proposal with `tags: ["proposal", "conflict", "flagged"]`.

## Step 4 — Report

```
Review complete: <n> proposals resolved
  accepted:  <n>
  kept old:  <n>
  merged:    <n>
  flagged:   <n>
```
