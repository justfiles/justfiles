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

## Model Context Hydration

The transcript is the durable source of truth, but the `pi-agent-core` Agent only sees what is held in `agent.state.messages` for the current turn. That in-memory array is tied to the Durable Object's lifetime: once the DO hibernates, it is gone. Unless we explicitly rebuild it on cold start, a resumed session is indistinguishable from a brand-new one from the model's perspective, even if the user just saw their previous messages replayed in the UI.

UI hydration (the `history` frame sent on WebSocket connect) is a visual replay only. It does not touch `agent.state.messages`. Model context hydration is a separate concern and must be treated as such.

### Prior-art reference

Both Pi's `SessionManager` and OpenClaw's embedded runner follow the same general pattern:

- the transcript on disk is fuller than anything the model sees in a single call
- the message list sent to the model is **derived** from persisted state, not replayed raw
- older turns are collapsed into summaries; recent turns are kept verbatim
- tool results are deliberately pruned or dropped across turns by default
- context assembly is token-budget driven, not fixed last-N

See `openclaw-session-hydration-research.md` for the full analysis. Frieren does not need to copy this exactly, but the separation between "persisted transcript" and "model-visible context" is the important idea.

### Target endpoint: hybrid summary + retained tail (Option C)

Eventually, on a resumed turn the Agent should see:

- a rolling summary covering older parts of the current internal session
- a retained tail of recent user/assistant text turns reconstructed from the transcript
- no replayed tool calls or tool results from prior turns

Tool calls and tool results remain durable in the transcript but are not rehydrated into `agent.state.messages`. This matches Pi and OpenClaw's explicit stance that old tool output is the first thing to drop from live context.

### Implementation order

The three phases build on each other in strict order:

**A. Text-only rehydration of recent turns.**

On the first turn after a cold start where the lifecycle resolution is `resume` and `agent.state.messages` is empty, read the last N transcript lines from the active session, keep only `user` and `assistant` text lines, and reconstruct a valid `Message[]` for `agent.state.messages` before calling `agent.prompt()`.

Intentionally lossy: `tool_call` and `tool_result` lines are dropped on rehydration. This avoids the tool-call-id reassembly problem (we do not persist `tool_call_id` in the transcript) and matches the long-term design where old tool output should not live in active context.

Edge cases:

- drop any leading orphan `toolResult`-shaped messages before assigning, in case rehydration logic later includes them — providers reject orphan tool results.
- if the transcript is empty or the session has no prior turns, rehydration is a no-op.
- if rehydration fails, log and fall back to an empty message list. The agent should still be able to take a turn.

The `windowMessages(20)` helper in `transformContext` already bounds how much rehydrated context the model sees per turn.

**B. Rolling summary generation.**

After Phase A is shipped, add rolling summary generation during active turns (see Phase 2 in "Next Phases"). The summary lives in the system prompt on every resumed turn via `buildSystemPrompt`, which already reads `rolling-summary.md` — that path is wired but the file is never written yet.

At this stage, the model sees both: a narrative summary of older turns (via system prompt) and the text-only rehydrated recent tail (via `agent.state.messages`). Together they cover the same ground the final hybrid does, just without any budget-driven compaction yet.

**C. Token-budget-driven compaction and retention.**

Once A and B are both working, refine the rehydration and summary logic so that:

- the retained tail length is driven by a token budget, not a fixed message count
- when the tail grows past the budget, older turns at the head of the tail are folded into the rolling summary rather than replayed raw
- rehydration reads from the transcript once per cold start and then relies on in-memory state for subsequent turns

This is the endpoint that matches the Pi/OpenClaw model. It should not be implemented ahead of A and B, because each earlier phase makes the next one simpler and testable in isolation.

### What not to do

- do not add a user-facing reset or "forget" command as a workaround
- do not persist `tool_call_id` into the transcript schema just to enable full-fidelity tool-call rehydration; the long-term design drops tool context across turns anyway
- do not couple UI history projection to model rehydration — they have different consumers and different fidelity requirements

### Accepted tradeoffs in Phase A

These are intentional and should only be revisited if a concrete requirement forces the issue. None of them are blockers for Phase B or Phase C.

- **Historical assistant provider/model are lossy.** `buildRehydratedMessages` in `frieren.ts` fills `api`, `provider`, and `model` from the *current* backend config, not from whatever produced the message originally. The transcript does not persist those fields. Fine as long as we do not depend on provider-specific continuity (prompt-cache signatures, opaque reasoning payloads, matching tool-call ids). If we ever need that, the fix is a transcript schema change, not a change to the rehydration program.
- **Historical timestamps are collapsed to `Date.now()`.** `RehydrationLine` drops `ts` from the original transcript line. The Agent does not use timestamps for logic, so this is invisible in practice.
- **`limit * 4` over-read is a heuristic.** `loadRehydrationMessages` reads `limit * 4` transcript lines to leave slack for dropped tool lines. A turn that is extremely tool-heavy could still underfill the rehydrated tail. This is a capacity loss, not a correctness loss. If it ever bites, replace the over-read with a streaming reader that keeps pulling until it has `limit` text-only lines or hits the head of the transcript.
- **Concurrency race on cold start.** If two prompts arrive on a cold DO before the first one finishes persisting, both turns may see `agent.state.messages.length === 0` and both rehydrate, with the second overwrite discarding any in-flight turn from the first. This race is not introduced by Phase A — the existing `isNewSession` clear branch has the same shape — but it is worth recording so it is not mistaken for a Phase A bug. A proper fix belongs with a broader per-turn serialization pass, not inside rehydration.
- **Corrupt current-session pointer is best-effort.** If `/sessions/current.json` points to a session whose transcript file is missing, `loadRehydrationMessages` surfaces `SessionNotFound`, which `frieren.ts` logs and swallows. The turn still runs with an empty message list. Graceful degradation, but not yet self-healing — a followup should have `resolveLifecycle` treat that state as "start a new session."

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

### Done (continued)

- UI history hydration on WebSocket connect with a fixed cap
- UI-facing projection from transcript lines to chat messages (`projectTranscriptToDisplay`)
- removal of user-facing `/new` reset command
- text-only model context rehydration on cold-start resume (Phase A):
	- `loadRehydrationMessages` program reads the active session transcript tail, keeps only `user` and `assistant` text lines, drops any leading non-user messages
	- `frieren.ts` rebuilds `agent.state.messages` from that tail when `prepareTurn` resolves to `resume` and the agent's in-memory state is empty
	- failures are logged and fall through to an empty message list so the turn still proceeds
	- `windowMessages(20)` in `transformContext` continues to bound per-call context
- rolling summary generation during active sessions (Phase B):
	- `maybeUpdateRollingSummary` regenerates `rolling-summary.md` from the active session transcript on a conservative completed-turn trigger
	- `frieren.ts` runs rolling summary updates after transcript persistence as a best-effort background maintenance step
	- `buildSystemPrompt` now consumes a file that is actually written during active sessions, not just at resume time

### Not Done Yet

- token-budget-driven tail retention with compaction into the rolling summary (Phase C)
- memory inbox extraction on close
- reflection / inbox processing pass
- permanent memory store beyond prompt/profile/session files
- explicit extraction of backend/model config into a reusable configuration module
- thin channel metadata in session/transcript records for future multi-channel support

## Next Phases

### Phase 1: UI History Hydration (done)

Added `loadRecentHistory` and `projectTranscriptToDisplay`. On WebSocket connect, the client receives a `history` frame with the latest N display messages before `ready`. The `/new` reset command was removed from the web chat product flow.

### Phase A: Text-Only Model Context Rehydration

Rebuild the Agent's live message list on cold-start resume so the LLM shares the user's view of the conversation.

Likely shape:

- add a program such as `loadRehydrationMessages` that reads the last N transcript lines for the current session and keeps only `user` and `assistant` text lines
- in `frieren.ts`, when `prepareTurn` returns `resume` and `agent.state.messages.length === 0`, call the program, convert the lines into valid `pi-ai` `Message[]` values (using the live backend's `api`/`provider`/`model` for assistant messages), and assign them to `agent.state.messages` before `agent.prompt()`
- drop any leading orphan `toolResult`-shaped message defensively (should not occur with text-only filtering, but the guard is cheap)
- on rehydration failure, log and continue with an empty message list

Outcome:

- after a Durable Object cold start, the Agent no longer acts amnesiac on a resumed session
- tool calls from prior turns are intentionally not rehydrated — they remain in the transcript as the durable record only

### Phase B: Rolling Summary

Done. `maybeUpdateRollingSummary` now regenerates `rolling-summary.md` from the active transcript once enough completed turns have accumulated, and `frieren.ts` triggers it after successful turn persistence. `buildSystemPrompt` already read `rolling-summary.md`; this phase made that file live.

### Phase C: Token-Budget-Driven Tail Retention

With Phase A and Phase B both in place, replace the fixed-count rehydration cap and the growth-trigger for the rolling summary with token-budget logic. Depends strictly on A and B.

Likely shape:

- estimate tokens across the rehydrated tail plus the system prompt
- when the tail exceeds a budget, fold the head of the tail into the rolling summary and drop those lines from rehydration on the next cold start
- keep cut points at user-message boundaries for clean rehydration

Outcome:

- resumed turns see a compacted summary plus a bounded recent tail, matching the Pi/OpenClaw model
- context length stays predictable as sessions grow

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

1. (done) remove `/new` from the web chat product flow
2. (done) add current-session history hydration on UI connect with a fixed cap
3. (done) add text-only model context rehydration on cold-start resume (Phase A)
4. add rolling summary generation for long internal sessions (Phase B, depends on A)
5. switch rehydration and summary triggers to token-budget-driven retention (Phase C, depends on A and B)
6. add memory inbox extraction on session close
7. add reflection flow in `frieren.ts`
8. add thin channel metadata only where it helps future extensibility

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
