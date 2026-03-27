---
name: capture
description: Frictionlessly capture a note into the ghostore inbox. Use when the user says "capture", "save this", "remember this", or wants to store a note.
argument-hint: [content to capture]
allowed-tools: Bash(ghostore *)
---

Capture a note into the ghostore inbox.

The content to capture is `$ARGUMENTS`. If no argument is given, ask: "What would you like to capture?"

Use `ghostore write` to write the note.

Report the returned memory ID on success.
