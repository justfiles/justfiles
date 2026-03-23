---
name: tasks
description: Read todos for a given project, pick the top 3 by priority, and let the user choose which to work on first.
argument-hint: <project name>
allowed-tools: mcp__ghostore__list_memories, mcp__ghostore__get_memory
---

Surface the top 3 priority tasks for the given project and help the user pick one.

Before starting, call `mcp__ghostore__get_memory` with `path: "readme"` to load the KB conventions (folder structure — todos live at `/<project>/todo/`).

## Step 1 — Fetch all todos

The argument is the project name. Call `mcp__ghostore__list_memories` with:
- `path_prefix`: `"<project>/todo"`
- `limit`: 30

## Step 2 — Read each todo

For each result, call `mcp__ghostore__get_memory` with its ID to get the full content.

## Step 3 — Rank by priority

Examine the tags and content of every todo. Use the following signals to rank:

- **Priority tag** — tags like `p1`, `p2`, `p3`, `p4` are explicit priority levels (p1 = highest).
- **Blocking** — todos that other todos depend on rank higher.
- **Impact** — prefer items that unblock search quality, core API, or agent workflows over polish/UX.
- **Effort** — if two items are otherwise equal, prefer the lower-effort one.

Select the **top 3** by this ranking.

## Step 4 — Present choices

Display a concise numbered list:

```
Which task do you want to work on?

1. <title> [p<n>] — <one-line description>
2. <title> [p<n>] — <one-line description>
3. <title> [p<n>] — <one-line description>
```

Wait for the user to pick a number (or say "none"). Then confirm their choice and offer to pull up the full task detail.
