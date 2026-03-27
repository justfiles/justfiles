---
name: review-proposals
description: Surface pending ghostore conflict proposals and guide the user through resolving each one — accept new, keep old, merge, or flag.
argument-hint: (no arguments needed)
allowed-tools: Bash(ghostore *)
---

Guide the user through reviewing and resolving conflict proposals.

Conflict proposals are created by `/enrich` when a new note contradicts an existing one. Run `/enrich` first if the inbox has unprocessed notes.

## Step 1 — Find pending proposals

Use `ghostore list` to find notes tagged `proposal`. If unsure of flags, run `ghostore list --help`.

If none found, report "no pending proposals — knowledge base is clean" and stop.

## Step 2 — Present each proposal

Use `ghostore get` on the proposal and on both referenced notes (`new_note_id` and `existing_note_id` from the proposal content).

Display:

```
─── Proposal <n> of <total> ──────────────────────────────
Conflict: <conflict_summary>

EXISTING NOTE  (<id> at <path>)
<full content>

NEW NOTE  (<id> at <path>)
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

Use `ghostore update` and `ghostore archive` as needed:

- **A**: Update the existing note with the new note's text. Archive both the new note and the proposal.
- **K**: Archive the new note and the proposal.
- **M**: Ask what to keep from each. Draft merged content, confirm with user, then update the existing note. Archive the new note and proposal.
- **F**: Update the proposal's tags to add `flagged`.

## Step 4 — Report

```
Review complete: <n> proposals resolved
  accepted:  <n>
  kept old:  <n>
  merged:    <n>
  flagged:   <n>
```
