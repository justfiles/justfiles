# Session & Memory Implementation Plan

This document reflects the current Effect-based session runtime in `apps/frieren/worker/session/effect/*`, updated with the current product decision:

- one Durable Object per user
- one visible chat surface for now: the web UI
- no user-managed "new chat" concept
- a single infinite chat thread from the user's perspective
- internal session rotation, summaries, and handoffs only for system health

The old plan centered on `SessionManager` and `TranscriptWriter` classes. That is no longer the design. The runtime is now organized around:

- Effect services for boundaries
- Effect programs for orchestration
- a live layer built on top of `@justfiles/fs` `Volume`
- `frieren.ts` as the integration point with the long-lived `pi-agent-core` agent

## Product Direction

Frieren should feel closer to WhatsApp or iMessage than to ChatGPT's multi-thread UI.

The user should experience:

- one continuous chat
- no manual session creation
- no `/new`
- no need to understand internal rotation

The system should still manage context internally so it can:

1. keep active context bounded
2. checkpoint long conversations into summaries and handoffs
3. rotate inactive or stale active state cleanly
4. restore recent chat history when the UI reconnects

## Tenancy Model

The Durable Object is already the user boundary.

That means:

- the DO owns the SQLite-backed filesystem for exactly one user
- internal session files do not need a `user_id` field
- session state is scoped to "this user's assistant state in this DO"

This is different from OpenClaw's gateway model, which has to route messages from many external senders and channels through one host process. Frieren does not need that level of routing yet.

## What Is a Session?

A session is not a user-facing concept.

The user sees one infinite conversation. Sessions exist only so the system can:

1. bound prompt/context growth
2. create summary and handoff checkpoints
3. archive inactive conversation epochs
4. recover cleanly after internal resets or failures

From the user's perspective, nothing special should happen when a session boundary occurs. Internally we:

- close the old session
- persist and archive its transcript
- generate a final summary and handoff
- start a new internal session
- continue rendering the same visible chat product

## Session vs Conversation

We should keep these concepts separate:

- visible conversation: the user's single web chat thread
- internal session: one bounded execution/context epoch inside that conversation

Long conversations should usually be handled by:

- rolling summaries
- handoffs
- transcript windowing
- pagination in the UI

They should not be handled by exposing multiple chats or requiring the user to start over.

## Current Policy Decision

### For now

- one visible conversation in the web UI
- one active internal session at a time
- no user-initiated session reset command
- recent transcript history must load when the UI connects

### Internal rotation triggers

Keep these system-owned only:

- idle timeout
- failure recovery when the transcript or agent state becomes invalid
- optional future freshness policy if we later decide we need one

### Do not use these as primary rotation triggers

- turn count
- token budget
- transcript length alone

Those should primarily drive:

- rolling summary refresh
- compaction
- memory extraction

not a user-visible or even frequent hidden session rollover.

This is the main lesson from OpenClaw that applies here: identity/routing boundaries and long-context management should stay separate.

## Channel Model

We should prepare for multi-channel future, but only with a thin model now.

### What to add now

Persist lightweight source metadata such as:

- `channel`
- `channel_conversation_id`
- possibly `message_id` or `client_message_id` when needed

For now:

- `channel` defaults to `"web"`
- `channel_conversation_id` can be the current web chat identifier if we need one, or omitted until the UI protocol needs it

### What not to build yet

- no general channel routing framework
- no cross-channel identity linking
- no per-channel session policy matrix
- no sender/peer identity model like OpenClaw's `peerId`

The DO already scopes the user. Right now channel is metadata, not a primary partitioning boundary.

## Current Live Design

The live runtime is split across four layers.

### 1. Filesystem Boundary

`@justfiles/fs` `Volume` is the portability boundary.

The runtime does not hardcode Durable Object storage semantics into the programs. Instead:

- the live layer injects the current DO SQLite-backed `Volume`
- tests inject an in-memory `Volume`
- future browser or alternate backend implementations can provide a different `Volume`

This remains the right abstraction surface because the session system fundamentally operates on files, while the rest of the code should not care how those files are stored.

### 2. Effect Services

Defined in `worker/session/effect/services.ts`:

- `Volume`
- `SessionClock`
- `SessionIdGenerator`
- `SessionStore`
- `TranscriptStore`
- `ContextStore`
- `TextGenerator`

These services are the dependency boundaries. They separate:

- filesystem-backed session metadata
- transcript persistence
- prompt/context file reads
- non-agent text generation
- runtime clock and id generation

### 3. Effect Programs

Defined in `worker/session/effect/programs.ts`:

- `resolveLifecycle`
- `startNewSession`
- `touchSession`
- `buildSystemPrompt`
- `closeSession`
- `persistTurn`
- `prepareTurn`

These are the business-logic entry points. They orchestrate the stores and generator without knowing about Cloudflare, the Agent instance, or the concrete `Volume` backend.

### 4. Live Integration

Defined in two places:

- `worker/session/effect/live.ts`
- `worker/frieren.ts`

`live.ts` provides the real store implementations and builds the managed runtime.

`frieren.ts` uses that runtime inside the Durable Object to:

- prepare the turn through Effect
- set the dynamic system prompt
- run the PI agent turn
- persist transcript lines back through Effect

## Current File Layout

```text
apps/frieren/worker/session/
	context.ts
	context.test.ts
	manager.test.ts
	transcript.test.ts
	types.ts
	effect/
		README.md
		errors.ts
		index.ts
		live.ts
		programs.ts
		services.ts
```

Important note: `manager.ts` and `transcript.ts` no longer exist. Their responsibilities were absorbed into the Effect stores and programs.

## Actual Runtime Flow

### Normal User Prompt

`frieren.ts:webSocketMessage(...)` currently does this:

1. parse the inbound WebSocket message
2. call `prepareTurn()`
3. `prepareTurn()` decides whether to:
	- resume the current session
	- start a new session
	- close and rotate before starting a new session
4. build the system prompt from:
	- `/soul.md`
	- `/profiles/user.md`
	- rolling summary for resumed sessions
	- latest handoff for newly started sessions
5. assign that prompt to the live PI agent
6. run `agent.prompt(...)`
7. extract transcript lines from the newly added agent messages
8. call `persistTurn(...)`

### Context Windowing

`agent.transformContext` remains intentionally small. It only does message windowing through `windowMessages(...)`.

That means:

- prompt assembly is an Effect program
- message trimming remains a pure helper
- the PI agent still owns the main turn loop

### Session Close

`closeSession(sessionId)` currently:

1. loads session metadata
2. marks the session as closing
3. reads the full transcript
4. generates:
	- `final-summary.md`
	- `handoff.md`
5. archives the session directory
6. updates `/sessions/current.json` with:
	- `current_session_id: null`
	- the latest handoff path

The live `TextGenerator` is already wired to a real `pi-ai` completion path in `frieren.ts`.

## Required Behavioral Changes

### 1. Remove user-managed reset flow

The current `frieren.ts` still handles `/new`.

That no longer matches the intended product.

We should remove user-facing session reset behavior from the chat surface and keep session creation/rotation entirely internal.

### 2. Load current session history on UI connect

Right now the UI expects a `history` payload, but the product behavior is still incomplete: when the user opens the chat UI, they should see the current session history immediately.

Target behavior:

- on WebSocket connect, load recent messages from the active session transcript
- send them to the client before or alongside the `ready` state
- keep the loaded slice bounded by a default max entry count

### 3. Separate visible chat entries from full transcript lines

The transcript should remain the full internal record, including:

- user messages
- assistant messages
- tool calls
- tool results
- future summaries or markers

The UI history API should produce a chat-oriented projection, not a raw internal transcript dump.

## History Loading Design

### Initial load

On UI connect:

- resolve the current active session
- read the latest transcript lines for that session
- project them into display messages
- return the latest N display entries

Reasonable initial default:

- 50 to 100 visible chat entries

The exact number can be tuned later.

### Older history

Out of scope for the first pass.

For now:

- load only the latest N visible chat entries
- keep that N capped
- do not implement backwards pagination yet

If needed later, we can revisit older-history loading as a future enhancement.

## Session Policy

### Active session policy

There should be exactly one current active session per DO.

`/sessions/current.json` remains the canonical pointer.

### Rotation policy

Rotation should be internal and conservative.

Good trigger now:

- idle timeout

Reasonable future triggers:

- transcript corruption or invalid agent state recovery
- explicit internal maintenance policy if real evidence shows it is needed

Not recommended as default rotation triggers:

- token budget
- turn count
- transcript length

Those should instead drive summarization and compaction behavior inside the current visible conversation.

## Current Status

### Done

- canonical file schemas and path definitions in `worker/session/types.ts`
- Effect service boundaries
- live store implementations on top of `Volume`
- session lifecycle resolution
- session creation
- transcript append and read operations
- prompt assembly for setup, resumed sessions, and handoff-based new sessions
- session close and archive flow
- live integration from `frieren.ts` into the Effect runtime
- migrated unit tests for session lifecycle, transcript persistence, and prompt assembly

### Partially Done

#### Internal Session Rotation

What exists now:

- lifecycle resolution already distinguishes between:
	- resume current session
	- start a new session
	- close the current session and start another one
- idle-time based rotation is implemented through `resolveLifecycle()` and `prepareTurn()`
- `closeSession()` archives the old session and `startNewSession()` creates the next one
- the next session can pick up the archived handoff through `latest_handoff_path`

What is still missing or should change:

- no central rotation policy module yet
- token growth and transcript growth are not yet redirected into summary/compaction policy
- the product still has a `/new` path in `frieren.ts`, which should be removed from the user-facing flow
- no reflection or memory-processing step is attached to the rotation boundary yet

What needs to happen next:

- define a single internal rotation policy centered on idle timeout
- remove user-initiated reset from the web chat product
- make the rotation reason explicit in tests
- keep future room for additional internal-only rotation reasons without exposing them to the user

#### Non-Agent Generation

What exists now:

- the `TextGenerator` Effect service is live
- `closeSession()` already uses it to generate:
	- `final-summary.md`
	- `handoff.md`
- the live implementation is no longer a placeholder; it is wired to a real `pi-ai` completion path from `frieren.ts`
- tests already exercise the orchestration path by mocking `GenerateText`

What is still missing:

- rolling summary generation does not use `TextGenerator` yet because rolling summaries are not implemented
- memory inbox extraction does not use `TextGenerator` yet because that phase is not implemented
- generated outputs do not yet have stronger structural expectations
- backend/model selection for session generation is still embedded in `frieren.ts`

### Not Done Yet

- rolling summary generation during active sessions
- transcript replay on connect for the current session
- transcript replay on connect for the current session, capped to a fixed recent-history window
- UI-facing projection from transcript lines to chat messages
- memory inbox extraction on close
- reflection / inbox processing pass
- permanent memory store beyond prompt/profile/session files
- explicit extraction of backend/model config into a reusable configuration module
- thin channel metadata in session/transcript records for future multi-channel support

## Next Phases

### Phase 1: Current Session History Hydration

Add history loading for the current active session.

Likely shape:

- add a program such as `loadRecentHistory`
- read the active session transcript
- project transcript lines into UI display messages
- send the latest N entries on WebSocket connect

Outcome:

- the user sees recent conversation history immediately when opening the web UI

### Phase 2: Rolling Summary

Add rolling summary generation to the active internal session.

Likely shape:

- add a program such as `maybeUpdateRollingSummary`
- trigger it from turn persistence after enough transcript growth
- use transcript growth or estimated token growth as summary triggers

Outcome:

- long internal sessions stay resumable without relying only on raw recent turns

### Phase 3: Memory Inbox

Add extraction of durable memory candidates during session close.

Likely shape:

- keep transcript and session archive logic in the existing stores
- generate structured memory candidates from the transcript during `closeSession`
- write them into `/memory/inbox`

Outcome:

- session closure produces durable memory candidates without overloading session metadata APIs

### Phase 4: Reflection Pass

Process inbox items before or around the first turn of a newly rotated session.

This likely belongs in `frieren.ts`, not in the Effect session programs, because it is agent-loop behavior rather than session storage orchestration.

Outcome:

- the agent can absorb, rewrite, merge, or discard inbox items using real tools

### Phase 5: Thin Multi-Channel Readiness

Prepare for future non-web inputs without overbuilding routing now.

Likely shape:

- add optional `channel` metadata to session/transcript-origin records
- add optional `channel_conversation_id` where useful
- keep policy fixed to the current single-web-chat product

Outcome:

- future email or chat-app inputs can be added without redesigning the core session file layout

## Why Effect Still Fits This Design

Effect is still a good fit because the runtime has several independent concerns that need to stay composable:

- file-backed state
- typed failures
- deterministic orchestration
- environment injection
- testability with in-memory backends

The main value is not frontend-style state management. The main value is making the internal session lifecycle explicit and injectable while keeping the visible product simple.

Effect gives us:

- typed dependency boundaries
- pure orchestration programs
- a clean live/test swap for `Volume`
- predictable integration points from `frieren.ts`

## Testing Strategy

Current tests already cover important pieces:

- `manager.test.ts`
	- lifecycle resolution
	- session creation
	- session touch/update
	- session close/archive
- `transcript.test.ts`
	- append
	- read all
	- read last N
- `context.test.ts`
	- windowing
	- prompt assembly

Testing approach from here:

- use `memStorage()` plus `volume()` for store and program tests
- mock `GenerateText` where generation behavior itself is not the unit under test
- add tests for current-session history hydration
- add tests that confirm no user-facing reset path exists in the web chat flow
- keep `frieren.ts` integration thin and let most business logic remain testable through Effect programs

## Implementation Order From Here

1. remove `/new` from the web chat product flow
2. add current-session history hydration on UI connect with a fixed cap
3. add rolling summary generation for long internal sessions
4. add memory inbox extraction on session close
5. add reflection flow in `frieren.ts`
6. add thin channel metadata only where it helps future extensibility

## Future Improvement Notes

### Older History Loading

We may later add a way to load older transcript history from the current session, but it should stay out of the first implementation.

For now, the product decision is:

- load a bounded recent-history slice only
- do not implement backwards pagination yet

That keeps the current direction intact:

- `Volume` remains the portability boundary
- Effect remains the orchestration layer
- PI remains the agent loop
- the user sees one simple continuous chat
