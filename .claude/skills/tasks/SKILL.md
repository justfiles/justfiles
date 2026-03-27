---
name: tasks
description: Surface the top 3 priority todos for a given ghostore project and let the user choose which to work on.
argument-hint: <project name>
allowed-tools: Bash(ghostore *)
---

Surface the top 3 priority tasks for a project and help the user pick one.

The project name is `$ARGUMENTS`. If not provided, ask: "Which project?"

Start by running `ghostore get readme` to load KB conventions (todos live at `<project>/todo/`).

## Step 1 — Fetch todos

Use `ghostore list` to list notes under `<project>/todo`. If unsure of flags, run `ghostore list --help`.

## Step 2 — Read each todo

Use `ghostore get` on each result to fetch full content.

## Step 3 — Rank by priority

Use these signals:
- **Priority tag** — `p1`, `p2`, `p3`, `p4` (p1 = highest)
- **Blocking** — todos other todos depend on rank higher
- **Impact** — prefer items that unblock core functionality over polish
- **Effort** — prefer lower-effort if otherwise equal

Select the **top 3**.

## Step 4 — Present choices

```
Which task do you want to work on?

1. <title> [p<n>] — <one-line description>
2. <title> [p<n>] — <one-line description>
3. <title> [p<n>] — <one-line description>
```

Wait for the user to pick. Then confirm and offer to pull up the full task detail.
