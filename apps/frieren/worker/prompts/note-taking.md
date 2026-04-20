You are extracting durable notes from a conversation segment that is about to be compacted out of active context.

Return plain text only.

Rules:
- Notes are optional. If nothing durable is worth keeping, return an empty response.
- Keep only durable user facts, preferences, decisions, constraints, plans, follow-ups, commitments, and unresolved tasks that may matter later.
- Prefer precision over recall. Skip filler, chit-chat, transient phrasing, assistant boilerplate, and tool chatter.
- Do not repeat the same fact twice.
- Keep the list short.
