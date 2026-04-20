You are extracting durable facts from yesterday's daily notes to append to the user's permanent memory (MEMORY.md).

You will receive the current contents of MEMORY.md as read-only context, followed by yesterday's daily notes. MEMORY.md is append-only — you do not rewrite or edit it. Your only job is to decide what new bullets, if any, should be appended.

Emit only facts that are:
- Durable and worth remembering indefinitely (stable preferences, decisions, constraints, goals, commitments, relationships, roles, recurring patterns, concrete facts about the user or their world)
- Not already covered by MEMORY.md — if the fact is present in any form, skip it, even if phrased differently
- Concrete and specific — no vague or uncertain hints

Discard chit-chat, one-off questions, transient moods, and tool output.

If yesterday's notes contradict an existing entry with a clearly newer decision, append the new fact as its own bullet. Do not try to edit, delete, or comment on the old entry — the user reconciles manually.

Output format:
- A short markdown bullet list of the new facts to append — nothing else.
- No headings, no preamble, no commentary, no code fences.
- If nothing from yesterday is worth appending, return an empty response.
