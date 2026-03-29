---
name: enrich
description: Run the enrichment pipeline on all ghostore inbox notes — categorize, find related notes, and decide ADD/UPDATE/SKIP/LINK/CONFLICT for each.
argument-hint: (no arguments needed)
allowed-tools: Bash(ghostore *)
---

Process all inbox notes through the enrichment pipeline.

Start by running `ghostore get readme` to load KB conventions (folder structure, path rules, tag vocabulary).

## Step 1 — Find inbox notes

Use `ghostore list` to list notes under the `inbox` path prefix. If unsure of flags, run `ghostore list --help`.

If no results, report "inbox is empty — nothing to enrich" and stop.

## Step 2 — For each inbox note, run the pipeline

Use `ghostore get` to fetch the full content of each note. Process one note at a time.

### 2a. Categorize

Assign:

**Path** — slash-delimited, lowercase, hyphen-separated:
- Project-specific: `<project>/<optional-subtopic>` (e.g. `ghostore/auth`)
- General knowledge: `notes/<topic>` (e.g. `notes/react`)
- Depth: 1–3 segments

**Tags** — 1–4 lowercase labels from: `decision`, `context`, `reference`, `idea`, `question`, `insight`, `summary`, `log`, `to-process`, `resource`, `pattern`

### 2b. Connect

Use `ghostore search` with the first ~80 words of the note as the query to find related notes. Exclude the current note from results.

Read any high-scoring candidates with `ghostore get`. Then make exactly one decision:

| Decision | Condition |
|---|---|
| **ADD** | No meaningful overlap — genuinely new. |
| **UPDATE** | A candidate covers the same topic but this note is more complete or accurate. |
| **SKIP** | Redundant — an existing note already captures this adequately. |
| **LINK** | Related but distinct and complementary — both should exist. |
| **CONFLICT** | Contradicts an existing note on a factual or opinion claim. |

### 2c. Execute

- **ADD**: Use `ghostore update` on the inbox note to assign the new `path` and `tags`. This relocates it without hitting the dedup gate.
- **UPDATE**: Merge the inbox note's content into the candidate. Use `ghostore update` on the candidate with the merged text, then `ghostore archive` on the inbox note.
- **SKIP**: Use `ghostore archive` on the inbox note.
- **LINK**: Use `ghostore update` on the inbox note to assign path and tags. Then use `ghostore link` to create the structured relationship (see `ghostore link --help` for flags). Note the relationship in the final summary.
- **CONFLICT**: Use `ghostore update` on the inbox note to assign path and tags. Then use `ghostore write` to create a conflict proposal at `proposals/<timestamp>` with tags `proposal,conflict` and source `agent`, containing: the two note IDs and a 1–2 sentence conflict summary.

## Step 3 — Report

```
Enrichment complete: <n> notes processed

  added:     <n>
  updated:   <n>
  skipped:   <n>
  linked:    <n>
  conflicts: <n>  ← run /review-proposals to resolve
```
