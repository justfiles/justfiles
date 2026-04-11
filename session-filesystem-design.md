# Session Filesystem Design

## Purpose

This document records:

- findings from researching OpenClaw session management
- findings from the current `ghostore` / `apps/frieren` setup
- a proposed filesystem-shaped session design
- multiple implementation options
- tradeoffs between those options
- a practical recommended plan

The design target is:

- Python runtime
- no OpenClaw coding-agent runtime
- filesystem-backed state, using the existing filesystem abstraction as the main storage model
- preserved raw conversations
- short-term continuity across sessions
- simple long-term memory writing

## Findings

### What OpenClaw does well

OpenClaw separates three concerns clearly:

- routing: a stable `sessionKey` decides which conversation bucket a message belongs to
- active transcript: a mutable pointer from `sessionKey` to the current `sessionId`
- persistence: full raw transcript is kept on disk, while carry-over context is compressed

The useful ideas to borrow are:

- one stable conversation key can outlive many concrete transcript files
- each concrete session gets its own transcript file
- old sessions are preserved, not overwritten
- the next session should not load old raw transcripts by default
- continuity comes from compact summaries and memory, not from replaying everything

### What OpenClaw does not do by default

OpenClaw does not appear to re-read the last several old transcripts on every new session by default.

Instead, it relies on:

- staying in the same active session while the conversation is ongoing
- in-session compaction when the transcript grows large
- optional memory plugins or hooks for carry-over
- explicit cross-session history tools when needed

That is the right constraint to keep.

### What the current `apps/frieren` setup does

Current strengths:

- `/soul.md` already exists as a root bootstrap prompt
- the agent already has filesystem tools: `read`, `write`, `ls`, `mkdir`, `rm`
- the filesystem abstraction is already durable and suitable as the primary storage model
- the DO-backed SQLite layer is already good enough to persist files across hibernation

Current weaknesses:

- conversation persistence is currently one flat `conversation` table
- there is no stable `session_key -> current session_id` layer
- there is no archive layout for old sessions
- there is no short-term handoff document between sessions
- there is no disciplined distinction between short-term and long-term memory

### Main design conclusion

The missing piece is not storage.

The missing piece is a session model on top of storage.

You already have the filesystem. You need:

- session identity
- transcript lifecycle
- handoff summaries
- long-term memory promotion rules

## Design Goals

The system should satisfy these goals:

1. Preserve all conversations.
2. Keep active context small and cheap.
3. Carry the right information into the next session.
4. Avoid reloading huge transcript history by default.
5. Make long-term memory explicit and inspectable as files.
6. Keep the model understandable enough to debug by reading files directly.

## Core Concepts

### `session_key`

A stable conversation bucket.

Examples:

- `user:alice`
- `user:alice:channel:web`
- `user:+61412345678:channel:whatsapp`

This answers:

- "Which conversation stream is this message part of?"

### `session_id`

A concrete transcript instance.

This answers:

- "Which exact session file are we currently appending to?"

One `session_key` can have many `session_id`s over time.

### Transcript

The full raw append-only conversation log for one `session_id`.

This is the source of truth for that session.

### Rolling summary

A compact in-session summary that helps keep context short while the session is still active.

### Handoff

A short note written when a session ends so the next session can continue from the right state without loading the full transcript.

### Long-term memory

Durable facts and preferences that should survive across many sessions.

## Recommended Filesystem Layout

```text
/soul.md
/profiles/
	{user_id}.md

/sessions/
	index.json
	keys/
		{session_key}.json
	active/
		{session_id}/
			meta.json
			transcript.jsonl
			rolling-summary.md
	archive/
		YYYY/
			MM/
				{session_id}/
					meta.json
					transcript.jsonl
					final-summary.md
					handoff.md

/memory/
	inbox/
		YYYY-MM-DD-HHMM-{slug}.md
	people/
		{user_id}.md
	topics/
		{topic}.md
```

## File Roles

### `/soul.md`

Always loaded.

Contains:

- assistant identity
- tone
- behavior rules
- standing operating instructions

### `/profiles/{user_id}.md`

Always loaded for that user.

Contains:

- stable user facts
- preferences
- recurring projects
- standing instructions from the user

This is the simplest durable long-term memory file.

### `/sessions/keys/{session_key}.json`

Small pointer file for session routing.

Suggested shape:

```json
{
	"session_key": "user:alice:channel:web",
	"current_session_id": "2026-04-12T09-20-31Z_f83a",
	"last_activity_at": "2026-04-12T10:04:11Z",
	"latest_handoff_path": "/sessions/archive/2026/04/2026-04-11T18-02-55Z_ab12/handoff.md"
}
```

### `/sessions/active/{session_id}/transcript.jsonl`

Append-only raw conversation.

Contains:

- user messages
- assistant messages
- tool calls
- tool results
- timestamps

### `/sessions/active/{session_id}/rolling-summary.md`

Short evolving summary of the current live session.

Used to avoid loading too much raw transcript into the model.

### `/sessions/archive/.../final-summary.md`

A more complete summary of what happened in a finished session.

Useful for humans and explicit review.

### `/sessions/archive/.../handoff.md`

A small, operational summary for the next session.

This is the main short-term memory bridge.

### `/memory/inbox/*.md`

Unreviewed or not-yet-promoted memory candidates.

Use this when the system notices something maybe durable but is not confident enough to merge it into the canonical profile yet.

### `/memory/people/{user_id}.md`

Optional canonical long-term memory file for that person.

This can be merged with `/profiles/{user_id}.md` if you want fewer moving parts.

## Session Lifecycle

### Start session

1. Resolve the `session_key`.
2. Read `/sessions/keys/{session_key}.json` if it exists.
3. Decide whether to reuse the current session or open a new one.
4. If reusing:
	- load `soul.md`
	- load profile
	- load rolling summary
	- load recent raw turns
5. If starting new:
	- create a new `session_id`
	- create the active session folder
	- update the `session_key` pointer
	- load `soul.md`
	- load profile
	- load the previous handoff if present

### During session

For each turn:

1. Append raw events to `transcript.jsonl`.
2. Optionally update a small `meta.json`.
3. Periodically regenerate `rolling-summary.md`.
4. Build model context from:
	- `soul.md`
	- profile
	- rolling summary
	- recent raw turns

### End session

When rolling over:

1. Finalize `final-summary.md`.
2. Write `handoff.md`.
3. Promote durable facts to long-term memory.
4. Move the session folder from `active/` to `archive/YYYY/MM/`.
5. Create a fresh active session for the same `session_key`.

## When To Start A New Session

Keep this policy simple.

Recommended triggers:

- explicit `/new`
- idle timeout, for example 6 hours
- daily rollover, if desired
- transcript too large even after compaction

Avoid clever hidden rules.

## Prompt Assembly Rules

### Existing active session

Load:

1. `/soul.md`
2. `/profiles/{user_id}.md`
3. `/sessions/active/{session_id}/rolling-summary.md`
4. last N turns from `transcript.jsonl`

### New session

Load:

1. `/soul.md`
2. `/profiles/{user_id}.md`
3. previous session `handoff.md`
4. optionally previous `final-summary.md` only as fallback

Do not automatically load the last few raw transcripts.

That is expensive, noisy, and eventually unstable.

## Summary Strategy

This is the fuzzy part, so keep it narrow and concrete.

Use two summaries, not one:

### Rolling summary

Purpose:

- support the current active session
- reduce context cost

Properties:

- short
- frequently regenerated
- disposable

Suggested sections:

```md
# Rolling Summary

## Current topic

## Decisions so far

## Open questions

## Temporary facts
```

### Handoff summary

Purpose:

- bridge from one session to the next

Properties:

- small
- written once at session end
- more stable than the rolling summary

Suggested sections:

```md
# Handoff

## Current context

## Open loops

## Recent decisions

## Temporary facts worth carrying
```

### Final summary

Purpose:

- archive readability
- explicit review

Properties:

- longer than handoff
- not loaded by default

## Long-Term Memory Rules

Only promote facts that are:

- stable
- likely useful later
- not tied to a single short-lived conversation

Good candidates:

- name
- preferences
- recurring projects
- style preferences
- standing instructions
- important relationships

Bad candidates:

- one-off debugging details
- ephemeral plans
- temporary emotional states
- session-specific logistics that will age badly

If unsure, write to `/memory/inbox/*.md` instead of the canonical profile.

## Options

## Option A: Small And Minimal

### Layout

```text
/soul.md
/profiles/{user_id}.md
/sessions/keys/{session_key}.json
/sessions/active/{session_id}/transcript.jsonl
/sessions/archive/.../{session_id}/transcript.jsonl
/sessions/archive/.../{session_id}/handoff.md
```

### Behavior

- keep full transcript forever
- no rolling summary
- new sessions load:
	- `soul.md`
	- profile
	- previous handoff
- long-term memory is just `/profiles/{user_id}.md`

### Advantages

- easiest to implement
- easiest to inspect manually
- very few files and moving parts
- good enough for many personal assistant use cases

### Disadvantages

- active sessions can get large
- no good in-session compaction mechanism
- handoff quality matters more because there is no separate rolling summary
- less flexible if you later want search or memory review workflows

### Best for

- single user
- low to medium conversation volume
- early prototype
- preference for maximum simplicity

## Option B: Balanced Recommended

### Layout

```text
/soul.md
/profiles/{user_id}.md
/sessions/keys/{session_key}.json
/sessions/active/{session_id}/
	meta.json
	transcript.jsonl
	rolling-summary.md
/sessions/archive/.../{session_id}/
	meta.json
	transcript.jsonl
	final-summary.md
	handoff.md
/memory/inbox/
```

### Behavior

- keep full transcript forever
- maintain a rolling summary while the session is active
- write a handoff and final summary when the session closes
- promote durable facts into profile or inbox

### Advantages

- still understandable
- much better short-term continuity
- active session context stays small
- archive stays readable
- separates current compression from next-session carry-over cleanly

### Disadvantages

- more files
- needs summary generation policy
- requires a small amount of memory promotion logic

### Best for

- the system you likely want
- one or more persistent users
- long conversations
- filesystem-first debugging and maintenance

## Option C: Full And Powerful

### Layout

```text
/soul.md
/profiles/{user_id}.md
/sessions/index.json
/sessions/keys/{session_key}.json
/sessions/active/{session_id}/
	meta.json
	transcript.jsonl
	rolling-summary.md
	checkpoints/
		{timestamp}.md
/sessions/archive/.../{session_id}/
	meta.json
	transcript.jsonl
	final-summary.md
	handoff.md
	extracted-facts.json
/memory/
	inbox/
	people/
	topics/
	projects/
	events/
	reviews/
```

### Behavior

- everything in the balanced option
- periodic checkpoint summaries inside active sessions
- extracted facts separated from natural-language summaries
- richer long-term memory namespaces
- optional indexing or search over archived session summaries
- optional review flow for memory promotion

### Advantages

- most scalable
- richest introspection
- better support for search and structured memory
- easier to build review and dedupe workflows later

### Disadvantages

- significantly more complexity
- easier to over-engineer
- harder to keep prompts and promotion logic disciplined
- more maintenance burden

### Best for

- many long-lived users
- large memory corpus
- explicit review workflows
- future semantic search or retrieval plans

## Tradeoffs

### Simplicity vs capability

- minimal is easiest to trust
- balanced is the best practical compromise
- full is best only if you are sure you need the extra machinery

### Raw transcript loading vs summary loading

- raw transcript loading preserves fidelity
- summary loading preserves budget and signal
- the right default is:
	- recent raw turns for the active session
	- a handoff summary for the next session

### One profile file vs many memory buckets

- one profile file is simpler and often enough
- many memory buckets are cleaner at scale
- start with one profile file and an inbox

### Automatic promotion vs cautious promotion

- aggressive promotion increases recall
- aggressive promotion also increases memory pollution
- default to cautious promotion

## Recommended Plan

Build Option B first.

Specifically:

1. Keep `/soul.md` as the always-loaded root prompt.
2. Add `/profiles/{user_id}.md` as the canonical long-term memory file.
3. Replace the single flat `conversation` table with a filesystem session layout.
4. Introduce `session_key` and `session_id`.
5. Store raw transcript as `transcript.jsonl`.
6. Maintain `rolling-summary.md` during the session.
7. Write `handoff.md` and `final-summary.md` at session end.
8. Add `/memory/inbox/` for uncertain memory candidates.

This gives:

- preserved raw history
- compact carry-over between sessions
- explicit long-term memory files
- a model that stays easy to debug

## Suggested First Implementation Scope

For the first pass, do only this:

- `soul.md`
- `profiles/{user_id}.md`
- `sessions/keys/{session_key}.json`
- `sessions/active/{session_id}/transcript.jsonl`
- `sessions/active/{session_id}/rolling-summary.md`
- `sessions/archive/.../{session_id}/final-summary.md`
- `sessions/archive/.../{session_id}/handoff.md`
- `memory/inbox/`

Skip for now:

- search
- structured extracted facts
- topic/project/event memory splits
- multi-level checkpointing

## Concrete Recommendation For `apps/frieren`

Refactor the current implementation so that:

- `/soul.md` stays as-is
- the agent no longer restores one global `conversation` table as the single truth
- each chat runs against a resolved `session_key`
- the current session transcript is stored as a file under `/sessions/active/`
- archived sessions move to `/sessions/archive/`
- the next new session loads profile plus handoff instead of old raw transcripts

The filesystem should be the source of truth.

If SQL is used, it should support the filesystem, not compete with it as a second conversation model.

## Follow-Up Work

A good next step would be to turn this document into:

- a Python `SessionManager` interface
- exact JSON schemas for `meta.json` and `keys/{session_key}.json`
- transcript event schema for `transcript.jsonl`
- prompt assembly code
- session rollover rules
- memory promotion rules
