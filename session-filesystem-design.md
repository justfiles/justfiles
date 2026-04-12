# Frieren Session & Memory Design

## Core Principle

This system has two layers with different ownership and different change velocities.

**The session layer is a machine.** The system writes it. Every file has a fixed schema, every trigger is concrete, every template has a word limit. The agent has no discretion here.

**The memory layer is Frieren's.** She owns the entire filesystem below `/memory/` (except the inbox). She decides how to organise it, when to restructure it, and what to merge, split, or discard. It evolves over time as she learns what retrieval patterns actually work.

Everything is a file. The volume implementation — whether Cloudflare DO-backed SQLite, a local disk, or a browser filesystem — is an infrastructure concern and does not affect this design.

---

## Part 1: Session Layer (System-Owned)

### Filesystem Layout

```
/soul.md
/profiles/{user_id}.md

/sessions/
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
```

Everything under `/sessions/` is written by the system. The agent never reads or writes session files directly. The system exposes session context to the agent through prompt assembly only.

---

### Core Concepts

**`session_key`**

A stable conversation bucket. One `session_key` persists across many concrete sessions.

Format: `user:{user_id}` or `user:{user_id}:channel:{channel}`

Examples:
- `user:alice`
- `user:alice:channel:web`
- `user:+61412345678:channel:whatsapp`

**`session_id`**

A concrete session instance. One `session_key` accumulates many `session_id`s over time.

Format: `{ISO8601 datetime with colons replaced by dashes}_{4-char lowercase hex}`

Example: `2026-04-12T09-20-31Z_f83a`

---

### File Schemas

#### `/sessions/keys/{session_key}.json`

```json
{
	"session_key": "user:alice:channel:web",
	"current_session_id": "2026-04-12T09-20-31Z_f83a",
	"last_activity_at": "2026-04-12T10:04:11Z",
	"latest_handoff_path": "/sessions/archive/2026/04/2026-04-11T18-02-55Z_ab12/handoff.md"
}
```

`current_session_id` is `null` when no session is active.
`latest_handoff_path` is `null` when there is no prior completed session.

---

#### `/sessions/active/{session_id}/meta.json`

```json
{
	"session_id": "2026-04-12T09-20-31Z_f83a",
	"session_key": "user:alice:channel:web",
	"user_id": "alice",
	"started_at": "2026-04-12T09:20:31Z",
	"last_activity_at": "2026-04-12T10:04:11Z",
	"turn_count": 42,
	"state": "active"
}
```

`state` is one of: `active`, `closing`, `archived`.

---

#### `/sessions/active/{session_id}/transcript.jsonl`

One JSON object per line. Append-only. Never modified after writing.

Four line types only:

```jsonl
{"ts": "2026-04-12T09:20:31Z", "role": "user", "content": "..."}
{"ts": "2026-04-12T09:20:35Z", "role": "assistant", "content": "..."}
{"ts": "2026-04-12T09:20:36Z", "role": "tool_call", "tool_name": "read_file", "input": {"path": "/soul.md"}}
{"ts": "2026-04-12T09:20:37Z", "role": "tool_result", "tool_name": "read_file", "content": "..."}
```

Required fields per role:

| role | required fields |
|---|---|
| `user` | `ts`, `role`, `content` |
| `assistant` | `ts`, `role`, `content` |
| `tool_call` | `ts`, `role`, `tool_name`, `input` |
| `tool_result` | `ts`, `role`, `tool_name`, `content` |

No additional fields. `content` in `tool_result` is a string; JSON-serialise complex values. `input` in `tool_call` is an object.

Transcripts are never loaded by default. They are only read when explicitly required (debugging, audit, explicit history review).

---

#### `/sessions/active/{session_id}/rolling-summary.md`

**Trigger:** Regenerate after every 20 turns, or when the estimated token count of unread raw turns exceeds 4,000 — whichever comes first.

**Template (exact, no deviations):**

```md
# Rolling Summary

updated: {ISO8601}

## Current topic
{1–3 sentences}

## Decisions made
{bullet list, max 5 items}

## Open questions
{bullet list, max 5 items}

## Temporary facts
{bullet list of facts that matter now but will not survive the session}
```

Maximum total length: 300 words. Write `none` for any section with nothing to say.

---

#### `/sessions/archive/YYYY/MM/{session_id}/handoff.md`

Written once at session end. Never updated after writing.

This is the only file loaded by default at the start of the next session. It must be fully self-contained.

**Template (exact, no deviations):**

```md
# Handoff

written: {ISO8601}
session: {session_id}

## What we were doing
{1–3 sentences describing the active task or conversation topic at session end}

## What is unresolved
{bullet list, max 5 items — omit section if nothing is unresolved}

## What changed that matters
{bullet list, max 5 items of facts, decisions, or state changes with durable relevance}
```

Maximum total length: 200 words.

---

#### `/sessions/archive/YYYY/MM/{session_id}/final-summary.md`

Written once at session end. Not loaded by default. Used for human review and audit.

**Template:**

```md
# Final Summary

written: {ISO8601}
session: {session_id}
duration: {started_at} → {ended_at}

## What happened
{paragraph summary of the full session}

## Key decisions
{bullet list}

## Facts worth preserving
{bullet list of facts flagged as memory candidates for Frieren's inbox}

## Mood and tone
{1 sentence characterising the session quality and user state, if notable — omit if unremarkable}
```

No hard length limit. Prefer concise over exhaustive.

---

### Session Lifecycle

#### Starting a session

1. Resolve `session_key` from the incoming message.
2. Read `/sessions/keys/{session_key}.json`.
	- File does not exist → start a new session.
	- `current_session_id` is `null` → start a new session.
	- `last_activity_at` is more than 6 hours ago → close the current session (run end-of-session steps), then start a new session.
	- Otherwise → resume the existing session.
3. **Resume existing session — load in order:**
	1. `/soul.md`
	2. `/profiles/{user_id}.md`
	3. `/sessions/active/{session_id}/rolling-summary.md`
	4. Last 20 turns from `transcript.jsonl`
4. **Start new session:**
	1. Generate `session_id`
	2. Create `/sessions/active/{session_id}/` with `meta.json` (state: `active`) and empty `transcript.jsonl`
	3. Update `/sessions/keys/{session_key}.json` to point to the new `session_id`
	4. Load in order:
		1. `/soul.md`
		2. `/profiles/{user_id}.md`
		3. `latest_handoff_path` if not `null`

Do not load old raw transcripts when starting a new session.

#### During a session

For every turn:

1. Append the turn to `transcript.jsonl` immediately, before generating a response.
2. Update `last_activity_at` and increment `turn_count` in `meta.json`.
3. Check rolling summary trigger. If triggered, regenerate `rolling-summary.md`.

#### Ending a session

Triggered by: explicit `/new` command, idle timeout (6 hours), or `turn_count` exceeding 200.

1. Set `state` to `closing` in `meta.json`.
2. Write `final-summary.md`.
3. Write `handoff.md`.
4. Write memory inbox candidates to `/memory/inbox/` (see Part 2).
5. Move the session folder from `/sessions/active/{session_id}/` to `/sessions/archive/YYYY/MM/{session_id}/`.
6. Set `state` to `archived` in `meta.json`.
7. Update `/sessions/keys/{session_key}.json`: set `current_session_id` to `null`, set `latest_handoff_path` to the new handoff path.

---

### Prompt Assembly

**Resuming existing session:**

```
1. /soul.md
2. /profiles/{user_id}.md
3. /sessions/active/{session_id}/rolling-summary.md
4. last 20 turns from transcript.jsonl
```

**Starting new session:**

```
1. /soul.md
2. /profiles/{user_id}.md
3. {latest_handoff_path}  (skip if null)
```

No other files are loaded by default. Loading additional context — old transcripts, archived summaries, memory files — is Frieren's decision during her turn, not the system's.

---

## Part 2: Memory Layer (Frieren-Owned)

Frieren owns the entire filesystem below `/memory/`, with one exception: the system writes to `/memory/inbox/` as the hand-off mechanism. Everything else — directory structure, file names, organisation strategy — is Frieren's to create, restructure, and maintain as she sees fit. The layout is expected to evolve over time.

### Layout

```
/memory/
	STRUCTURE.md               ← Frieren's own documentation of her current layout
	inbox/
		{YYYY-MM-DD-HHMM}-{slug}.md   ← written by system at session end only
	{... everything else Frieren decides ...}
```

---

### Inbox

The inbox is the boundary between the system and Frieren's memory layer. The system writes candidates here at session end. One file per candidate.

**Inbox file format:**

```md
---
captured: {ISO8601}
session: {session_id}
user: {user_id}
confidence: low|medium|high
---

{the fact, observation, preference, or material to consider}
```

Inbox files are never modified after writing. Frieren reads and processes them during reflection passes. She does not write to the inbox directly.

---

### Reflection Pass

Frieren runs a reflection pass at the start of each new session, after loading soul.md, the profile, and the handoff — before the conversation begins.

During a reflection pass, Frieren:

1. Reads `/memory/STRUCTURE.md` to recall her current layout.
2. Reads all files in `/memory/inbox/`.
3. For each inbox file, decides one of:
	- **Absorb**: integrate the fact into an existing memory file.
	- **Create**: create a new memory file if no suitable category exists.
	- **Defer**: leave the inbox file in place and revisit next session.
	- **Discard**: the information is no longer relevant, incorrect, or too ephemeral to keep.
4. Evaluates whether the current memory layout still serves retrieval well.
5. If reorganisation is warranted: moves, merges, renames, or removes files, then updates `STRUCTURE.md`.
6. Deletes processed inbox files.

The reflection pass must complete in one focused agent turn before the session continues. If the inbox is large, prefer deferring over processing slowly.

---

### `/memory/STRUCTURE.md`

Frieren writes and maintains this file. It documents her current organisation and her reasoning for it.

It must answer:

- What directories and files currently exist under `/memory/`?
- Why is the information organised this way?
- What changed in the most recent reorganisation, and why?

This file is loaded at the start of every reflection pass. It is not loaded during normal sessions.

Example (illustrative only — the actual structure is Frieren's to decide):

```md
# Memory Structure

last updated: 2026-04-12

## Current layout

- `people/alice.md` — long-term facts about Alice: preferences, context, standing instructions
- `projects/frieren.md` — notes on the Frieren project: current state, decisions, open threads
- `preferences.md` — cross-session patterns and recurring preferences not tied to one person

## Rationale

Merged `topics/` into `projects/` after noticing topic files were always project-specific.
Removed `events/` because time-indexed facts were more usefully stored inside person or project files.

## Last change

2026-04-10: collapsed three thin topic files into `projects/frieren.md`.
```

---

### Memory Promotion Guidelines

Frieren decides what to promote. These are guidelines for her judgment, not system constraints:

**Promote:**
- Stable facts specific to the user (name, timezone, preferences, standing instructions)
- Recurring projects and their current state
- Confirmed patterns in user communication or working style

**Do not promote:**
- One-off debugging details
- Ephemeral plans that have already resolved
- Session-specific logistics
- Anything with an expiry implied by its nature

**When uncertain:** write to inbox with `confidence: low` rather than promoting directly.

**Prefer updating existing files** over creating new ones. If a file grows unwieldy, split it — but update `STRUCTURE.md` to explain the split.

---

## Profiles

### `/profiles/{user_id}.md`

The user profile is a filesystem file maintained by Frieren under a fixed schema. It is loaded on every session. Frieren may update the content within sections but must not rename or remove sections.

**Template (fixed sections):**

```md
# Profile: {user_id}

updated: {ISO8601}

## Identity
name: {display name}
timezone: {IANA timezone string}
preferred language: {language}

## Standing instructions
{bullet list of explicit user-given instructions that always apply}

## Recurring projects
{bullet list of active long-term projects}

## Preferences
{bullet list of confirmed style, communication, and behavior preferences}
```

Maximum length: 300 words. Keep it current; remove facts that are no longer true.

Long-form or evolving notes about the user belong in Frieren's memory layer, not here.

---

## `/soul.md`

Always loaded. Never modified by Frieren or the system at runtime.

Contains:
- Frieren's identity
- Tone and behavior rules
- Standing operating instructions

Changes to `/soul.md` are made by the developer only.
