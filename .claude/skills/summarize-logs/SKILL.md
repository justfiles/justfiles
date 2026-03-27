---
name: summarize-logs
description: Group ghostore session/log notes by time window, extract durable learnings into a summary note, and archive the originals.
argument-hint: [today | this-week | YYYY-MM-DD (default: today)]
allowed-tools: Bash(ghostore *)
---

Summarize unprocessed log notes into compact, durable knowledge notes, then archive the originals.

Start by running `ghostore get readme` to load KB conventions (path conventions and tag meanings).

## Input

`$ARGUMENTS` specifies the time window:
- `today` — logs created today (default)
- `this-week` — logs created in the past 7 days
- `YYYY-MM-DD` — logs created on that specific date

## Step 1 — Find unprocessed logs

Use `ghostore list` to find notes tagged `log` and `to-process`. If unsure of flags, run `ghostore list --help`.

Filter results client-side:
- Path must contain `/logs/`
- Creation date must fall within the requested time window

If no results, report "no unprocessed logs found for <window>" and stop.

## Step 2 — Read and group

Use `ghostore get` on each result. Group by:
1. **Project** — from path prefix (e.g. `ghostore` from `ghostore/logs/session-1`)
2. **Date** — from each note's creation date

Process one project-date group at a time.

## Step 3 — Extract durable learnings

For each group synthesize:
- **Key decisions** — what was decided and why
- **Insights** — observations worth preserving long-term
- **Open questions** — unresolved issues needing follow-up
- **Actions taken** — significant things that were done

Target 20–30% of original length. Discard ephemeral status updates.

## Step 4 — Write the summary

Use `ghostore write` to create a summary at `<project>/summary/<YYYY-MM-DD>` (or `notes/summary/<YYYY-MM-DD>` if logs span multiple projects), tagged `summary,log`, source `agent`.

## Step 5 — Archive originals

Use `ghostore archive` on each summarized log note.

## Step 6 — Report

```
Summarized <n> log notes across <m> project(s) for <window>

  <project> → <project>/summary/<date>  (<n> logs)
```
