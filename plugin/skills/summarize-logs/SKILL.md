---
name: summarize-logs
description: Group session/log notes by time window, extract durable learnings into a summary note, and archive the originals.
argument-hint: [today | this-week | YYYY-MM-DD (default: today)]
allowed-tools: mcp__ghostore__list_memories, mcp__ghostore__search_memory, mcp__ghostore__get_memory, mcp__ghostore__write_memory, mcp__ghostore__archive_memory
---

Summarize unprocessed log notes into compact, durable knowledge notes, then archive the originals.

Before starting, call `mcp__ghostore__get_memory` with `path: "readme"` to load the KB conventions (path conventions and tag meanings).

## Input

`$ARGUMENTS` specifies the time window:
- `today` — logs created today (default)
- `this-week` — logs created in the past 7 days
- `YYYY-MM-DD` — logs created on that specific date

## Step 1 — Find unprocessed logs

Call `mcp__ghostore__list_memories` with:
- `tags`: `["log", "to-process"]`
- `limit`: 200

Then filter the results client-side:
- Path must contain `/logs/` (e.g. `ghostore/logs/session-1`)
- Creation date must fall within the requested time window

If no results remain, report "no unprocessed logs found for <window>" and stop.

## Step 2 — Read and group

Call `mcp__ghostore__get_memory` for each result.

Group the logs in two dimensions:
1. **Project** — derived from the path prefix (e.g. `ghostore` from `ghostore/logs/session-1`)
2. **Date** — derived from each node's creation date

Process one project-date group at a time.

## Step 3 — Extract durable learnings

For each group synthesize:
- **Key decisions** — what was decided and why
- **Insights** — observations worth preserving long-term
- **Open questions** — unresolved issues needing follow-up
- **Actions taken** — significant things that were done

Target 20–30% of original length. Discard ephemeral status updates and low-signal chatter.

## Step 4 — Write the summary

For each project-date group, call `mcp__ghostore__write_memory` with:
- `text`: the formatted summary
- `path`: `<project>/summary/<YYYY-MM-DD>` (or `notes/summary/<YYYY-MM-DD>` if logs span multiple projects)
- `tags`: `["summary", "log"]`
- `source`: `"agent"`

## Step 5 — Archive originals

For each log node that was summarized, call `mcp__ghostore__archive_memory` to remove it from the active set.

## Step 6 — Report

```
Summarized <n> log notes across <m> project(s) for <window>

  ghostore  → ghostore/summary/<date>  (<n> logs)
  <project> → <project>/summary/<date> (<n> logs)
```
