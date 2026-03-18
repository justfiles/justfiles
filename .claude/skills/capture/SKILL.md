---
name: capture
description: Frictionlessly capture a note into the inbox with source tagging. Dedup is handled automatically by the store.
argument-hint: [content to capture]
allowed-tools: mcp__ghostore__capture_memory
---

Capture a note into the ghostore inbox.

## Input

The content to capture is `$ARGUMENTS`. If no argument is given, ask the user: "What would you like to capture?"

## What to do

Call `mcp__ghostore__capture_memory` with:
- `text`: the content
- `source`: `"human"`
- `path`: omit — defaults to `inbox/<timestamp>`

Report the returned memory ID on success.
