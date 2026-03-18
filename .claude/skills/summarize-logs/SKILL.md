---
name: summarize-logs
description: Group session/log notes by time window, extract durable learnings into a summary note, and archive the originals.
argument-hint: [today | this-week | YYYY-MM-DD (default: today)]
allowed-tools: mcp__ghostore__search_memory, mcp__ghostore__get_memory, mcp__ghostore__capture_memory
---

Summarize session and log notes into a compact, durable knowledge note.

## Input

`$ARGUMENTS` specifies the time window:
- `today` — notes from today (default)
- `this-week` — notes from the past 7 days
- `YYYY-MM-DD` — notes from that specific date

Compute the `occurred_after` / `occurred_before` ISO timestamps from the window.

## Step 1 — Find log notes

Call `mcp__ghostore__search_memory` with:
- `query`: `"session log"`
- `filter.fields.tags`: `"log"`
- `filter.occurred_after` / `filter.occurred_before`: derived from the time window
- `limit`: 100

If no notes found, report "no session notes found for <window>" and stop.

## Step 2 — Read and group

Call `mcp__ghostore__get_memory` for each result. Group by session or topic cluster; fall back to chronological order.

## Step 3 — Extract durable learnings

For each group synthesize:
- **Key decisions** — what was decided and why
- **Insights** — observations worth preserving long-term
- **Open questions** — unresolved issues needing follow-up
- **Actions taken** — significant things that were done

Target 20–30% of original length. Discard ephemeral status updates and low-signal chatter.

## Step 4 — Capture the summary

Call `mcp__ghostore__capture_memory` with:
- `text`: the formatted summary
- `path`: `sessions/summary/<YYYY-MM-DD>`
- `tags`: `["summary", "session"]`
- `source`: `"agent"`

## Step 5 — Report

```
Summarized <n> session notes → sessions/summary/<date>

Summary preview:
<first 5 lines>
```
