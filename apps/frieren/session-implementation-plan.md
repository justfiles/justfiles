# Session & Memory Implementation Plan

## What Is a Session?

A session is **not** a user-facing concept. The user sees one continuous conversation — like a WhatsApp chat or a Slack DM — that goes on forever. There is no "new chat" button in the normal flow.

A session is an **invisible compression boundary** managed by the system. It exists because:

1. **Context window is finite** — we can't feed the entire history to the LLM every turn
2. **Summaries need a scope** — "what happened" needs a start and end point
3. **Handoffs carry continuity** — instead of raw history, the next session gets a compressed handoff note (200 words vs thousands of transcript lines)

From the user's perspective, nothing changes when a session boundary occurs. They keep talking. The system silently:
- Compresses the old session into a handoff
- Extracts durable facts into the memory inbox
- Starts a new session with the handoff loaded as context

Session boundaries are triggered by:
- **Idle timeout (6 hours)** — user stopped talking, came back later
- **Turn limit (200 turns)** — conversation has been going long enough that context needs checkpointing
- **Explicit `/new` command** — user wants a fresh start (rare, power-user feature)

There is no `channel` concept. One user = one DO instance = one continuous conversation. The DO holds one `current_session_id` at a time. Sessions accumulate over time as archived history.

---

## Current State

The Frieren DO already has:
- A `pi-agent-core` Agent with WebSocket streaming
- `@justfiles/fs` Volume backed by DO SQLite
- Filesystem tools (read, write, ls, mkdir, rm)
- Conversation persistence in a `conversation` table
- System prompt loaded from `/soul.md` (with first-run setup flow)

What's missing: the entire session lifecycle, transcript logging, rolling summaries, handoffs, memory inbox, reflection passes, and dynamic context assembly.

---

## Architecture

```
frieren.ts (DO)
  │
  ├── Agent (long-lived, one per DO instance)
  │     ├── transformContext    ← injects session context per-turn
  │     ├── subscribe(turn_end) ← transcript, touch, summary trigger
  │     └── subscribe(agent_end) ← final persistence barrier
  │
  ├── SessionManager           ← lifecycle state machine + all session I/O
  │     ├── resolve / startNew / touch / close / maybeUpdateSummary
  │     └── reads: soul, profile, rolling summary, handoff, inbox
  │
  └── TranscriptWriter         ← append-only JSONL via Volume
```

**Two components, not five.** Everything that was previously PromptAssembler, RollingSummaryEngine, SessionCloser, and ReflectionPass is now either:
- A method on `SessionManager` (filesystem + LLM operations)
- A hook on the `Agent` (context injection, event handling)

The Agent hooks call into SessionManager. SessionManager does not know about the Agent.

### Key Design Choice: Long-Lived Agent, Not Agent-per-Session

Learned from pi's coding agent: the Agent is a composition target, not a disposable instance. Context management happens through hooks, not by recreating the Agent.

- **One Agent per DO instance.** Created on DO wake (hibernation or first access), lives until DO eviction.
- **`transformContext` handles context assembly per-turn.** Reads soul.md, profile, rolling summary from SessionManager and injects them as context before each LLM call. No need to set `systemPrompt` once and recreate.
- **`subscribe()` listeners handle side effects.** Transcript writes, meta updates, summary triggers, session close checks — all in awaited listeners.
- **`agent.followUp()` handles reflection.** After a session rotation, queue the reflection prompt as a follow-up so it runs before the user's next message reaches the LLM.

### Key Design Choice: One User = One DO Instance

There is no `session_key`, `channel`, or `user_id` routing. One account = one user = one DO instance. The DO holds `/sessions/current.json` which tracks the single active session. Profile lives at the fixed path `/profiles/user.md`. This maps naturally to CF Durable Objects — `FRIEREN.idFromName(account_id)` gives each account its own persistent state. If multi-user is ever needed, it's a new DO per person, not multi-user within one DO.

---

## How pi Hooks Wire to Sessions

### `transformContext` — Context Assembly Per-Turn

Called before every LLM call. This is where the system injects session-aware context.

```
transformContext(messages, signal) {
  1. Read soul.md via sessionManager.readSoul()
  2. Read profile via sessionManager.readProfile()
  3. Read rolling summary via sessionManager.readRollingSummary(sessionId)
  4. Read handoff (if new session) via sessionManager.readHandoff(path)
  5. Build system context from these files
  6. Window messages to last N turns (context budget)
  7. Return transformed messages
}
```

This replaces the old PromptAssembler. Context is always fresh — if the rolling summary updates mid-session, the next turn sees it immediately.

### `subscribe()` → `turn_end` — Per-Turn Side Effects

Listeners are **awaited in registration order**, creating barriers in the agent loop.

```
subscribe(turn_end) {
  1. Extract user + assistant messages from event
  2. transcriptWriter.append(sessionId, lines)
  3. meta = sessionManager.touch(sessionId)
  4. sessionManager.maybeUpdateSummary(sessionId, meta)
  5. if (meta.turn_count > 200) → queue session close
}
```

### `subscribe()` → `agent_end` — Final Barrier

The agent doesn't become idle until all `agent_end` listeners complete. Perfect for ensuring all writes are flushed.

### `agent.followUp()` — Reflection Pass

After session rotation (close old + start new), if the memory inbox has items:

```
inbox = sessionManager.readInbox()
if (inbox.length > 0) {
  agent.followUp({
    role: "user",
    content: buildReflectionPrompt(inbox),
    timestamp: Date.now()
  })
}
```

The reflection runs as a full agent turn with tool access — Frieren can read/write memory files. It happens before the user's next message because follow-ups fire when the agent would otherwise stop.

---

## Data Flow Lifecycles

The DO instance is the user. It stores `/sessions/current.json` with the active session state:

```json
{
  "current_session_id": "2026-04-12T09-20-31Z_f83a",
  "last_activity_at": "2026-04-12T10:04:11Z",
  "latest_handoff_path": "/sessions/archive/2026-04-11T18-02-55Z_ab12/handoff.md"
}
```

`current_session_id` is `null` when no session is active.
`latest_handoff_path` is `null` when there is no prior completed session.

### Lifecycle 1: New User, First Message

```
WebSocket message arrives
  │
  ├─ 1. sessionManager.resolve()
  │     /sessions/current.json does NOT exist
  │     → { action: 'start_new', latest_handoff_path: null }
  │
  ├─ 2. sessionManager.startNew()
  │     a. Generate session_id
  │     b. mkdir /sessions/active/{session_id}/
  │     c. Write meta.json (state: "active", turn_count: 0)
  │     d. Write empty transcript.jsonl
  │     e. Write /sessions/current.json
  │
  ├─ 3. agent.prompt(user_message)
  │     │
  │     ├─ transformContext runs:
  │     │   reads soul.md + profile → builds context
  │     │   (no rolling summary yet, no handoff)
  │     │
  │     ├─ LLM responds, tools execute
  │     │
  │     └─ turn_end listener runs:
  │         transcript.append() → touch() → maybeUpdateSummary()
  │
  └─ 4. Events streamed to client via WebSocket
```

### Lifecycle 2: Returning User, Resuming Session

```
WebSocket message arrives
  │
  ├─ 1. sessionManager.resolve()
  │     current_session_id is NOT null, last_activity < 6h ago
  │     → { action: 'resume', session_id }
  │
  └─ 2. agent.prompt(user_message)
        │
        ├─ transformContext runs:
        │   reads soul.md + profile + rolling summary
        │   windows messages to last 20 turns from transcript
        │
        └─ (same turn_end side effects)
```

### Lifecycle 3: Returning User, Session Expired (>6h idle)

```
WebSocket message arrives
  │
  ├─ 1. sessionManager.resolve()
  │     last_activity > 6h ago
  │     → { action: 'close_and_start', old_session_id, latest_handoff_path }
  │
  ├─ 2. sessionManager.close(old_session_id)
  │     a. Set state → "closing"
  │     b. Generate final-summary.md (LLM via GenerateText)
  │     c. Generate handoff.md (LLM via GenerateText)
  │     d. Write memory inbox candidates
  │     e. Rename active → archive
  │     f. Set state → "archived", update current.json
  │
  ├─ 3. sessionManager.startNew()
  │
  ├─ 4. Queue reflection if inbox is non-empty:
  │     agent.followUp(reflectionPrompt)
  │
  └─ 5. agent.prompt(user_message)
        │
        ├─ transformContext runs:
        │   reads soul.md + profile + handoff from previous session
        │
        ├─ LLM responds to user
        │
        └─ After agent stops, follow-up fires:
            reflection prompt → agent processes inbox with tools
```

### Lifecycle 4: Session Close via Turn Limit or /new Command

```
Same as Lifecycle 3 step 2 onwards, but triggered by:
- turn_count > 200 (checked in turn_end listener)
- User sends "/new" command (detected in webSocketMessage)
```

---

## Phase Breakdown

### Phase 0: Type Definitions & Interfaces

**Goal**: Define all types and interfaces before writing any implementation. This pins down the shape of every surface boundary so we can iterate on the design cheaply — changing a type is free, changing wired-up code is not.

**File**: `worker/session/types.ts`

**What it defines**:
- **File schemas**: `CurrentSession`, `SessionMeta`, `TranscriptLine`, `InboxCandidate` — the JSON shapes stored in the Volume
- **State machine output**: `ResolveResult` — the discriminated union that `SessionManager.resolve()` returns
- **Component interfaces**: `SessionManager`, `TranscriptWriter` — the two components that own session state
- **LLM boundary**: `GenerateText` — the single mockable function signature for all non-agent LLM calls
- **Canonical paths**: `PATHS` — every filesystem path as a function or constant, so all components agree on layout

**Status**: Done. See `worker/session/types.ts`.

---

### Phase 1: Session State Machine + Filesystem Scaffolding

**Goal**: SessionManager can start, resume, and close sessions. Files are written to the Volume in the correct structure. No LLM-generated summaries yet — placeholders only.

**Files to create/modify**:
- `worker/session/manager.ts` — SessionManager implementation
- `worker/session/transcript.ts` — TranscriptWriter implementation
- `worker/frieren.ts` — wire SessionManager into WebSocket lifecycle

**What it does**:
1. On first message: `resolve()` → `startNew()` creates session directory + files
2. On subsequent messages: `turn_end` listener calls `touch()` + `transcript.append()`
3. On `/new` command: `close()` renames to archive, `startNew()` creates new session
4. On reconnect with stale session (>6h): same as `/new`

**What it does NOT do yet**:
- No rolling summary (written as empty placeholder)
- No final-summary.md or handoff.md (placeholder text)
- No memory inbox
- No reflection pass
- No `transformContext` wiring (system prompt is still set directly)

**Verification**:
- Send messages → inspect Volume via `/fs` API to see session files created
- Send `/new` → old session appears in `/sessions/archive/{id}/`
- Reconnect after modifying `last_activity_at` to >6h ago → auto-close + new session
- Transcript.jsonl contains correct JSONL lines

**TDD approach**: Yes — all of this is unit-testable.
- `manager.ts`: operates on Volume — use `memStorage` + `volume()` in tests
- `transcript.ts`: same approach

```
Test cases for manager.ts:
  ✓ resolve() with no current.json → returns { action: "start_new" }
  ✓ resolve() with active session < 6h → returns { action: "resume", session_id }
  ✓ resolve() with active session > 6h → returns { action: "close_and_start", old_session_id }
  ✓ resolve() with current_session_id: null → returns { action: "start_new", latest_handoff_path }
  ✓ startNew() creates correct directory structure and files
  ✓ close() renames active to archive, updates current.json
  ✓ touch() increments turn_count and updates last_activity_at
  ✓ generateSessionId() produces correct format (ISO datetime + 4-char hex)

Test cases for transcript.ts:
  ✓ append user turn → JSONL line with ts, role, content
  ✓ append assistant turn → JSONL line
  ✓ append tool_call → JSONL line with tool_name + input
  ✓ append tool_result → JSONL line with tool_name + content (stringified)
  ✓ readLastN(20) returns last 20 lines in order
  ✓ readLastN(20) on transcript with 5 lines returns all 5
```

---

### Phase 2: transformContext Wiring

**Goal**: The Agent uses `transformContext` to dynamically assemble context per-turn from session files. This replaces the old static `systemPrompt` approach.

**Files to modify**:
- `worker/frieren.ts` — add `transformContext` hook to Agent constructor

**What it does**:
1. Before each LLM call, `transformContext` reads session files from SessionManager
2. Builds system context: soul.md + profile + rolling summary (or handoff for new sessions)
3. Windows the Agent's messages to fit context budget
4. Returns the transformed message array

**Verification**:
- Write `/soul.md` and `/profiles/user.md` manually
- Chat → verify LLM receives both in context
- After rolling summary is generated (Phase 3) → verify it appears in context
- After session rotation → verify handoff appears in context

**TDD approach**: The `transformContext` function itself can be tested as a pure function given mock SessionManager reads.

```
Test cases:
  ✓ injects soul.md content as first context message
  ✓ injects profile content when present
  ✓ injects rolling summary when session has one
  ✓ injects handoff when starting new session after close
  ✓ skips missing files gracefully
  ✓ windows messages to last N turns
```

---

### Phase 3: Rolling Summary

**Goal**: After every 20 turns (or ~4000 tokens of raw turns), the system generates a rolling summary.

**Files to modify**:
- `worker/session/manager.ts` — implement `maybeUpdateSummary()`

**What it does**:
1. `turn_end` listener calls `sessionManager.maybeUpdateSummary(sessionId, meta)`
2. Check: `turn_count % 20 === 0` OR estimated tokens since last summary > 4000
3. If triggered: read recent turns from transcript, call `GenerateText` with template, write rolling-summary.md
4. Next turn, `transformContext` picks up the updated summary automatically

**Verification**:
- Chat for 20+ turns → rolling-summary.md appears with correct format
- Content matches the template (sections, word limit)
- Summary updates after another 20 turns

**TDD approach**: Partially.
- Trigger logic (`shouldRegenerate`) is pure and fully testable
- Token estimation is pure and testable
- LLM call mocked via `GenerateText`

```
Test cases:
  ✓ shouldRegenerate(turn_count=19, tokensSinceLast=100) → false
  ✓ shouldRegenerate(turn_count=20, tokensSinceLast=100) → true
  ✓ shouldRegenerate(turn_count=15, tokensSinceLast=4001) → true
  ✓ estimateTokens(turns) → rough count (chars/4)
  ✓ maybeUpdateSummary writes file at correct path with correct format
```

---

### Phase 4: Session Close — Final Summary, Handoff, Inbox, Archive

**Goal**: When a session ends, the system generates summaries, writes inbox candidates, and archives.

**Files to modify**:
- `worker/session/manager.ts` — implement full `close()` logic
- `worker/frieren.ts` — wire close triggers (turn limit, `/new`, idle timeout)

**What it does**:
1. Set meta.json state → "closing"
2. `GenerateText`: generate final-summary.md from full transcript
3. `GenerateText`: generate handoff.md (template-constrained, 200 words max)
4. `GenerateText`: extract memory candidates → write to `/memory/inbox/`
5. `vol.rename()` active → archive
6. Update current.json

**Verification**:
- Send `/new` → archive folder has final-summary.md, handoff.md, meta.json, transcript.jsonl
- Templates are followed exactly
- Memory inbox has files with correct frontmatter
- current.json updated with latest_handoff_path

**TDD approach**: Partially.
- File moves and state updates: testable with memStorage Volume
- LLM calls: mocked via GenerateText

```
Test cases:
  ✓ close() sets state to "closing" then "archived"
  ✓ close() renames active to archive
  ✓ close() updates current.json (null session, handoff path set)
  ✓ close() handles empty transcript gracefully
  ✓ inbox file has correct frontmatter format
  ✓ inbox filename follows {YYYY-MM-DD-HHMM}-{slug}.md pattern
```

---

### Phase 5: Reflection Pass

**Goal**: At the start of each new session, Frieren processes her memory inbox.

**Files to modify**:
- `worker/frieren.ts` — queue reflection via `agent.followUp()` after session rotation

**What it does**:
1. After `close()` + `startNew()`, read inbox via `sessionManager.readInbox()`
2. If non-empty: build reflection prompt, call `agent.followUp(reflectionPrompt)`
3. Reflection runs as a full agent turn with tool access (before user's next message)
4. Frieren reads inbox items, decides absorb/create/defer/discard, uses fs tools

**Verification**:
- Manually write files to `/memory/inbox/`
- Start a new session → agent processes inbox
- Inbox files are moved/deleted after processing
- `/memory/STRUCTURE.md` is updated

**TDD approach**: The prompt construction is testable. The actual reflection behavior depends on the LLM.

```
Test cases:
  ✓ buildReflectionPrompt(inboxFiles) → well-formed prompt
  ✓ buildReflectionPrompt with empty inbox → returns null (skip)
  ✓ buildReflectionPrompt with missing STRUCTURE.md → prompt says to create it
```

---

## File Structure After Implementation

```
apps/frieren/worker/
  ├── index.ts              (existing, unchanged)
  ├── app.ts                (existing, unchanged)
  ├── db.do.ts              (existing, unchanged)
  ├── tools.ts              (existing, unchanged)
  ├── frieren.ts            (modified — Agent hooks wire to SessionManager)
  ├── env.d.ts              (existing)
  └── session/
      ├── types.ts           (done — types, interfaces, PATHS)
      ├── manager.ts         (SessionManager: all session lifecycle)
      ├── transcript.ts      (TranscriptWriter: append, readLastN, readAll)
      └── __tests__/
          ├── manager.test.ts
          └── transcript.test.ts
```

Compared to the previous plan: no `ids.ts`, `prompt.ts`, `summary.ts`, `closer.ts`, `inbox.ts`, or `reflection.ts`. Those concerns are either methods on SessionManager or inline in the Agent hooks in frieren.ts.

---

## TDD Summary

| Module | Pure Logic (unit testable) | I/O with Volume (testable via memStorage) | LLM calls (mock/skip) |
|--------|--------------------------|------------------------------------------|----------------------|
| types.ts | 100% (just types + PATHS) | — | — |
| manager.ts | resolve logic, trigger checks, token estimation, ID generation | File CRUD, rename, state transitions | summary, handoff, inbox extraction |
| transcript.ts | Line formatting | append, readLastN, readAll | — |
| frieren.ts (hooks) | transformContext assembly | — | — |

**Strategy**: SessionManager takes a `Volume` and `GenerateText` as constructor args. Both are mockable. All filesystem operations go through Volume. All LLM operations go through GenerateText.

### Test infrastructure

```ts
import { memStorage } from '@justfiles/fs/storage.mem'
import { volume } from '@justfiles/fs'

function testVolume(): Volume {
  return volume(memStorage())
}

const mockGenerate: GenerateText = async (_sys, _user) => "mock response"
```

---

## Implementation Order & Dependencies

```
Phase 0: types.ts (done)
  │
Phase 1: transcript.ts → manager.ts → frieren.ts wiring (+ tests)
  │       ↓ verifiable: session files appear in Volume, transcript works
  │
Phase 2: transformContext hook in frieren.ts
  │       ↓ verifiable: agent gets correct context per session state
  │
Phase 3: manager.maybeUpdateSummary() (+ tests for trigger logic)
  │       ↓ verifiable: rolling-summary.md regenerates after 20 turns
  │
Phase 4: manager.close() full implementation (+ tests)
  │       ↓ verifiable: /new archives session with all expected files
  │
Phase 5: reflection via agent.followUp() in frieren.ts
          ↓ verifiable: inbox items processed at session start
```

Each phase produces working, deployable code. No phase depends on a later phase being complete.
