# Session & Memory Implementation Plan

This document reflects the current Effect-based session runtime in `apps/frieren/worker/session/effect/*`.

The old plan centered on `SessionManager` and `TranscriptWriter` classes. That is no longer the design. The runtime is now organized around:

- Effect services for boundaries
- Effect programs for orchestration
- a live layer built on top of `@justfiles/fs` `Volume`
- `frieren.ts` as the integration point with the long-lived `pi-agent-core` agent

## What Is a Session?

A session is not a user-facing concept. The user sees one continuous conversation. Sessions exist only so the system can:

1. keep the active context bounded
2. checkpoint a long conversation into summaries and handoffs
3. rotate between active and archived state cleanly

From the user's perspective, nothing special happens when a session boundary occurs. Internally we:

- close the old session
- persist a transcript
- generate a final summary and handoff
- start a new session
- load either rolling context or the latest handoff on the next turn

Current triggers:

- idle timeout: 6 hours
- explicit `/new`

Planned trigger:

- turn-count or token-budget based rotation

## Current Live Design

The live runtime is split across four layers.

### 1. Filesystem Boundary

`@justfiles/fs` `Volume` is the portability boundary.

The runtime does not hardcode Durable Object storage semantics into the programs. Instead:

- the live layer injects the current DO SQLite-backed `Volume`
- tests inject an in-memory `Volume`
- future browser or alternate backend implementations can provide a different `Volume`

This is the right abstraction surface because the session system fundamentally operates on files, but the rest of the code should not care how those files are stored.

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

`frieren.ts` uses that runtime inside the Durable Object:

- handles `/new`
- prepares the turn through Effect
- sets the dynamic system prompt
- runs the PI agent turn
- persists transcript lines back through Effect

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

### New or Normal User Prompt

`frieren.ts:webSocketMessage(...)` currently does this:

1. parse the inbound WebSocket message
2. if the message is `/new`, close the active session and start another one
3. otherwise call `prepareTurn()`
4. `prepareTurn()` decides whether to:
   - resume the current session
   - start a new session
   - close and rotate before starting a new session
5. build the system prompt from:
   - `/soul.md`
   - `/profiles/user.md`
   - rolling summary for resumed sessions
   - latest handoff for newly started sessions
6. assign that prompt to the live PI agent
7. run `agent.prompt(...)`
8. extract transcript lines from the newly added agent messages
9. call `persistTurn(...)`

### Context Windowing

`agent.transformContext` remains intentionally small. It only does message windowing through `windowMessages(...)`.

That means:

- prompt assembly is now an Effect program
- message trimming remains a pure helper
- the PI agent still owns the main turn loop

This is a better split than the old plan because `transformContext` does not need to become a large I/O-heavy hook.

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

- session rotation exists for idle timeout and `/new`
- non-agent generation exists for final summary and handoff

### Not Done Yet

- rolling summary generation during active sessions
- memory inbox extraction on close
- reflection / inbox processing pass
- permanent memory store beyond prompt/profile/session files
- turn-limit based rotation
- explicit extraction of backend/model config into a reusable configuration module

## Next Phases

### Phase 1: Rolling Summary

Add rolling summary generation to the active session.

Likely shape:

- extend `ContextStore` and/or `SessionStore` only if a new write boundary is actually needed
- add a program such as `maybeUpdateRollingSummary`
- trigger it from the turn persistence path after enough turns or enough transcript growth

Outcome:

- resumed sessions use a compact rolling summary instead of depending only on raw recent turns

### Phase 2: Memory Inbox

Add extraction of durable memory candidates during session close.

Likely shape:

- keep transcript and session archive logic in the existing stores
- add a dedicated memory-oriented store only when the logic becomes distinct enough
- generate structured memory candidates from the transcript during `closeSession`
- write them into `/memory/inbox`

Outcome:

- session closure produces durable memory candidates without overloading the session metadata APIs

### Phase 3: Reflection Pass

Process inbox items before or around the first turn of a newly rotated session.

This likely belongs in `frieren.ts`, not in the Effect session programs, because it is agent-loop behavior rather than session storage orchestration.

Outcome:

- the agent can absorb, rewrite, merge, or discard inbox items using real tools

### Phase 4: Memory Store

Introduce a dedicated memory-oriented service when permanent memory logic becomes large enough.

This should happen only when the boundary is genuinely different from session files. Right now the current split is:

- `SessionStore` for session lifecycle metadata and archive transitions
- `TranscriptStore` for append/read transcript operations
- `ContextStore` for prompt-facing reads

A future `MemoryStore` should represent real business logic, not just another folder on the same volume.

## Why Effect Fits This Design

Effect is a good fit here because the session runtime has several independent concerns that need to stay composable:

- file-backed state
- typed failures
- deterministic orchestration
- environment injection
- testability with in-memory backends

The main value is not "state management" in the frontend sense. The main value is making the session lifecycle explicit and injectable.

Effect gives us:

- typed dependency boundaries
- pure orchestration programs
- a clean live/test swap for `Volume`
- predictable integration points from `frieren.ts`

XState may still have a place later if the lifecycle itself becomes a richer explicit state machine. Right now the current lifecycle is simple enough that Effect programs plus typed stores are the lower-complexity choice.

## Testing Strategy

Current tests already cover the important pieces:

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

Testing approach:

- use `memStorage()` plus `volume()` for store and program tests
- mock `GenerateText` where generation behavior itself is not the unit under test
- keep `frieren.ts` integration thin and let most business logic remain testable through Effect programs

## Implementation Order From Here

1. add rolling summary generation as another Effect program
2. add memory inbox extraction on session close
3. add reflection flow in `frieren.ts`
4. introduce a dedicated memory store only when the memory logic becomes large enough to justify its own boundary

That keeps the current direction intact:

- `Volume` remains the portability boundary
- Effect remains the orchestration layer
- PI remains the agent loop
