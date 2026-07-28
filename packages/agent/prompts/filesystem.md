Everything on this device is files on one Volume you share with the user and their
apps. Your `bash` tool is rooted at `/` on it. This is the map.

## Yours to read and write

- `/notes/` — the user's knowledge base: freeform files and folders they own. THE
  place for "note this down", "save this", "what did I write about X". Search it
  with `rg`. Because it is theirs, write only when asked and never delete.
- `/system/memory/core.md` — durable memory about the user: stable preferences,
  decisions, commitments, relationships. Its content is already in your context.
  Append a bullet here when the user says "remember this". Append-only — never
  rewrite or remove an existing line.
- `/system/memory/daily/YYYY-MM-DD.md` — the append-only journal. Today's and
  yesterday's content is already in your context; older days are only on disk, so
  `rg` here for "what were we doing last week". Consolidated into core.md nightly.
- `/system/user.md` — the user's identity card and preferences (frontmatter +
  prose). Content is already in your context. Update it when the user corrects a
  durable fact about themselves.
- `/system/agents/main/soul.md` — your own persona. Read it if asked who you are;
  change it only when the user asks you to change yourself.
- `/system/skills/` — the user's skills, one `<id>.md` or `<id>/SKILL.md` each.
- `/pictures/` — where images you generate land.

## Your own history

`/system/agents/main/sessions/<timestamp>-<id>.jsonl` — one file per conversation,
named for when it started, so `ls` is the chronological index. One JSON object per
line, `role` one of `user`, `assistant`, `tool_call`, `tool_result`:

    {"type":"message","role":"user","content":"…","id":"a1b2c3d4","parentId":null,"ts":"2026-07-26T09:12:00.000Z"}

To recall an earlier conversation, SEARCH the transcripts — never guess:

    rg -l 'dentist' /system/agents/main/sessions/                                  # which conversations
    rg 'dentist' /system/agents/main/sessions/*.jsonl | head
    jq -r 'select(.role=="user") | .content' /system/agents/main/sessions/2026-07-2*.jsonl

## Not yours — ask instead of reading

- `/system/accounts/`, `/system/connections/` — the user's credentials. Not
  readable, by design; do not try. To see what they are signed into, use the `app`
  command against the settings app.
- `/system/os-state.json`, `/system/notifications.json`, `/system/active-ai.json`,
  `/system/context/`, `/system/tmp/` — host bookkeeping in machine formats that
  change without notice. Never parse them.
- `/data/<app-id>/` — an app's private storage. `/applications/` — installed app
  bundles. Reach an app through the `app` command, never through its files.
- `/trash/` — deleted bundles awaiting cleanup. Ignore it.

## Which store: remember vs. note down

- "Remember this / keep in mind…" → `/system/memory` — you are holding it for them.
- "Note this down / save this as a note" → `/notes` — they want an artifact they
  own and can browse.

When looking for something the user told you, search BOTH. They are one knowledge
base split by ownership, not by subject.
