# Effect Draft For `worker/session/*`

This folder is an isolated sketch of what an Effect-based session layer could
look like without changing the current runtime path.

## Shape

- `services.ts`
  - declares the dependency boundaries as Effect services
  - `Volume`, `SessionStore`, `TranscriptStore`, `ContextStore`, `TextGenerator`
- `programs.ts`
  - contains orchestration programs built from those services
  - `resolveLifecycle`, `startNewSession`, `closeSession`, `prepareTurn`
- `live.ts`
  - wires a draft runtime
  - injects a real `@justfiles/fs` `Volume`
  - real clock/id generator
  - everything else intentionally returns `NotImplemented`
- `errors.ts`
  - sketches typed domain failures

## Intended Mapping To Current Code

- `frieren.ts:webSocketMessage(...)`
  - `prepareTurn`
  - `agent.prompt(...)`
  - `persistTurn`
- `manager.ts`
  - becomes the implementation behind `SessionStore` and `ContextStore`
- `transcript.ts`
  - becomes the implementation behind `TranscriptStore`
- non-agent LLM calls
  - become `TextGenerator.generate(...)`

## Volume As The Portability Boundary

The draft now treats `@justfiles/fs` `Volume` as an Effect service directly.

That means later you can provide:

- the current DO SQLite-backed `Volume`
- a memory-backed `Volume` in tests
- a browser-backed `Volume`
- a completely different backend that still satisfies the same `Volume` interface

The orchestration programs still do not depend on `Volume` directly. The intent
is for repo implementations to `yield* Volume` and keep path/file mechanics
behind those service boundaries.

## Why This Shape

The goal is to separate:

- effectful orchestration
- storage concerns
- prompt-file reads
- transcript persistence
- non-agent generation

without replacing PI's own agent loop.
