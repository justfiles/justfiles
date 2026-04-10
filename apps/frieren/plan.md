# Frieren — Personal AI Assistant on Cloudflare Workers

## Overview

A personal AI assistant running on Cloudflare Workers + Durable Objects, using
[pi-agent-core](https://github.com/badlogic/pi-mono/tree/main/packages/agent) +
[pi-ai](https://github.com/badlogic/pi-mono/tree/main/packages/ai) for the LLM
orchestration layer, with a React web UI communicating over WebSocket.

The agent is **not** a coding agent — it is a personal assistant whose primary
capability is managing its own memory via a SQLite-backed virtual filesystem
(`@justfiles/fs`) living inside the Durable Object.

## Architecture

```
┌─────────────────────────┐
│   React Web UI          │
│   (Vite + CF Assets)    │
│                         │
│   Chat panel            │
│   Streaming messages    │
│   Tool execution viz    │
└───────────┬─────────────┘
            │ WebSocket (upgrade via Worker)
            │
┌───────────▼─────────────┐
│   Cloudflare Worker      │
│   (router / auth)        │
│   - upgrades WS to DO    │
│   - serves static assets │
└───────────┬─────────────┘
            │ DO stub.get() / stub.fetch()
            │
┌───────────▼─────────────┐
│   Durable Object         │
│   "AssistantSession"     │
│                          │
│   ┌────────────────────┐ │
│   │ pi-agent-core      │ │
│   │ Agent + tool loop  │ │
│   └────────┬───────────┘ │
│            │              │
│   ┌────────▼───────────┐ │
│   │ pi-ai              │ │
│   │ LLM provider calls │ │
│   └────────────────────┘ │
│                          │
│   ┌────────────────────┐ │
│   │ @justfiles/fs      │ │
│   │ Volume on DO SQL   │ │
│   │ (agent memory)     │ │
│   └────────────────────┘ │
│                          │
│   WebSocket Hibernation  │
│   DO SQLite (sessions,   │
│   fs, conversation)      │
└──────────────────────────┘
```

## Key Decisions & Reasoning

### Why pi-agent-core + pi-ai (not the full pi-coding-agent)

The `pi-coding-agent` package bundles bash/read/write/edit tools that require
`child_process` (stub-only in Workers) and real filesystem access. The lower
packages are runtime-agnostic:

- `pi-agent-core`: Stateful agent loop, tool execution, event streaming.
  Single dependency on `pi-ai`. No Node.js-specific APIs.
- `pi-ai`: HTTP clients for LLM providers (Anthropic, OpenAI, Google, etc).
  Uses `fetch()` which is native in Workers.

Community has already run these in Workers — issues
[#2395](https://github.com/badlogic/pi-mono/issues/2395) (ajv crash, fixed)
and [#2935](https://github.com/badlogic/pi-mono/issues/2935) (tool validation)
confirm viability with patches.

### Why Durable Objects (not plain Workers)

- **Stateful**: Each DO instance holds an agent session, WebSocket connections,
  and SQLite database. No external state store needed.
- **WebSocket Hibernation**: Connection stays alive at the edge while the DO
  sleeps. Zero duration cost during idle. Wakes on incoming message.
- **SQLite built-in**: 256MB included, expandable. Perfect for session
  persistence and `@justfiles/fs` Storage backend.
- **No cold-start penalty for WS**: The initial HTTP upgrade is one request.
  Subsequent messages are cheap (20:1 billing ratio).

### Why @justfiles/fs Volume for agent memory

The agent needs a filesystem to manage its own memory (notes, context, user
preferences). `@justfiles/fs` provides:

- A clean `Volume` interface (`readFile`, `writeFile`, `mkdir`, `readdir`, etc.)
- A `Storage` backend abstraction (9 async K/V operations)
- Existing backends: `memStorage`, `idbStorage`, `fsStorage`
- We need a new `sqliteStorage` backed by DO's built-in SQLite

This gives the agent a full POSIX-like filesystem without any Node.js deps.

### Why WebSocket (not SSE or polling)

- Bidirectional: user sends prompts, agent streams events back. SSE would
  require a separate HTTP POST channel for user input.
- Hibernation support: Cloudflare's WebSocket Hibernation API means idle
  connections cost nothing in DO duration billing.
- Natural fit for pi's event subscription model: `agent.subscribe(event => ws.send(event))`.

### Session management: roll our own (not pi's SessionManager)

pi's `SessionManager` is currently sync-only
([#2616](https://github.com/badlogic/pi-mono/issues/2616)), designed for local
JSONL files. The maintainer plans an async refactor for "server mode" but it's
not shipped. We'll persist conversation state directly in DO SQLite, which gives
us atomic writes and survives hibernation/eviction.

## Known Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| `ajv.compile()` uses `new Function()`, blocked in Workers | Medium | Fixed upstream. If not, wrap in try/catch to skip validation (LLM output is trusted enough). |
| DO CPU limit: 30s default per request | Medium | Agent turns with many sequential tool calls could exceed this. Break long runs into chained `alarm()` invocations, or increase via `limits.cpu_ms` in wrangler config (up to 5min on paid plan). |
| DO memory limit: 128MB | Low | Personal assistant context is small. Not loading entire codebases. Monitor and paginate if needed. |
| pi packages import Node.js globals (e.g. `process`, `Buffer`) | Medium | `nodejs_compat` flag is already set. Test early — Phase 1 will surface these issues. |
| pi-ai provider auth assumes file-based storage | Low | Use `InMemoryAuthStorage` from pi-ai and inject API keys from Worker secrets / env vars. |
| `@sinclair/typebox` may use `new Function()` internally | Medium | Test in Phase 1. If it crashes, pin to a version that uses interpreter mode or swap to manual validation. |
| pi upstream changes / instability | Low | Pin exact versions. The core agent API (`Agent`, `prompt()`, `subscribe()`) is stable. |
| WebSocket message ordering during rapid interaction | Low | DO processes messages sequentially by design. No race conditions. |

## Phases

---

### Phase 1: Minimal Chat — Agent in DO, WebSocket, React UI

**Goal**: A working end-to-end chat. User opens the web app, connects via
WebSocket to a Durable Object, sends a message, and sees the streaming LLM
response rendered in real-time.

**What this proves**: pi-agent-core + pi-ai run in Cloudflare Workers with
`nodejs_compat`. WebSocket hibernation works. The streaming event model works
over WebSocket. The React UI can render streaming text.

#### Tasks

1. **Install pi packages**
   - `bun add @mariozechner/pi-agent-core @mariozechner/pi-ai`
   - Test that they import without crashing in a Worker context
   - Document any import errors and patches needed

2. **Define the Durable Object: `Frieren`**
   - WebSocket Hibernation API (`webSocketMessage`, `webSocketClose`, etc.)
   - On `webSocketMessage("prompt", { text })`:
     - Create/reuse an `Agent` from pi-agent-core
     - Call `agent.prompt(text)`
     - Subscribe to events, forward each as a JSON WebSocket frame
   - On hibernation wake: reconstruct agent state from DO SQLite
   - Add to `wrangler.jsonc`: durable object binding + SQLite migration

3. **Wire the Worker router**
   - `GET /ws` → upgrade to WebSocket, route to DO by user/session ID
   - Keep existing `/api/` routes for future REST endpoints
   - Auth: start with a simple API key from env (good enough for personal use)

4. **Define the WebSocket protocol**
   ```
   // Client → Server
   { type: "prompt", text: string, id?: string }
   { type: "abort" }

   // Server → Client
   { type: "event", event: AgentSessionEvent }
   { type: "error", message: string }
   { type: "ready" }
   ```

5. **Build the React chat UI**
   - Minimal: message list + input box + send button
   - Connect to `ws://localhost/ws` on mount
   - Parse incoming `event` frames, accumulate `text_delta` into messages
   - Show tool calls as collapsible blocks (name + args + result)
   - Handle connection lifecycle (connecting → ready → disconnected)

6. **Configure LLM provider**
   - Start with Anthropic (Claude) via `pi-ai`
   - API key stored as Worker secret (`wrangler secret put ANTHROPIC_API_KEY`)
   - Inject into agent via `InMemoryAuthStorage` or direct provider config

#### Verification

- `bun run dev` starts the Vite dev server + Worker
- Open `http://localhost:5173`, see the chat UI
- Type a message, see streaming response from Claude
- Refresh the page → WebSocket reconnects, can chat again
- Check Cloudflare dashboard: DO is created, hibernates between messages

---

### Phase 2: Persistent Memory — Volume on DO SQLite

**Goal**: The agent has a virtual filesystem backed by DO SQLite. It can
read/write files to remember things across conversations. Conversations
themselves are persisted and survive DO eviction.

**What this proves**: `@justfiles/fs` Storage works on DO SQLite. The agent
can use custom tools to interact with the filesystem. State persists across
hibernation cycles.

#### Tasks

1. **Implement `sqliteStorage` backend for `@justfiles/fs`**
   - New file: `packages/fs/storage.do-sqlite.ts` (or in `apps/frieren/worker/`)
   - Implements the `Storage` interface (9 methods) using DO's `ctx.storage.sql`
   - Tables: `inodes`, `blobs`, `dirents`, `xattrs`
   - Implement `StorageCapabilities`: `atomicCreate`, `getXattr`, `setXattr`,
     `listXattrs`, `removeXattr`, `deltaUpdates` (for sync later)
   - Initialize root inode on first access

2. **Register agent tools: `read`, `write`, `ls`, `mkdir`, `rm`**
   - Each tool wraps a `Volume` method
   - Define TypeBox schemas for tool parameters
   - Register with the `Agent` via pi-agent-core's tool API
   - Tools operate on paths within the agent's virtual filesystem

3. **Persist conversation history in DO SQLite**
   - Table: `messages` (id, role, content, tool_calls, created_at)
   - On agent events: append to the table
   - On WebSocket connect: replay recent messages to the client
   - On hibernation wake: rebuild agent message context from DB

4. **Add session management basics**
   - Each user gets a DO instance (keyed by user ID or session ID)
   - Store agent config (model, system prompt) in DO SQLite
   - System prompt includes instructions for using the memory tools

5. **Update the UI for memory awareness**
   - Show when the agent reads/writes files (tool call visualization)
   - Optional: add a file browser panel showing the agent's memory filesystem

#### Verification

- Chat with the agent: "Remember that my favorite color is blue"
- Agent uses the `write` tool to save a file
- Refresh the page, ask: "What's my favorite color?"
- Agent uses the `read` tool and answers correctly
- Kill the DO (wait for eviction), reconnect → memory persists
- Check DO SQLite via wrangler: files and messages are there

---

### Phase 3: Polish & Capabilities

**Goal**: Make it actually useful as a daily personal assistant. Better UI,
more tools, conversation management, mobile-friendly.

#### Tasks

1. **Conversation management**
   - Multiple conversations (list, create, switch, delete)
   - Conversation titles (auto-generated or user-set)
   - Message history with scroll-back

2. **Context/compaction**
   - Implement conversation summarization when context gets long
   - Use pi-agent-core's compaction support if compatible, or roll our own
   - Store summaries in DO SQLite, prune old messages

3. **Enhanced tools**
   - `search`: search across memory files by content
   - `list_tree`: recursive directory listing
   - `edit`: partial file edits (not just full rewrites)

4. **UI improvements**
   - Markdown rendering for assistant messages
   - Code syntax highlighting
   - Mobile-responsive layout (reuse learnings from ghostore PWA)
   - Dark/light theme
   - Keyboard shortcuts (Cmd+Enter to send, Escape to cancel)

5. **Auth & multi-user**
   - Proper auth (Cloudflare Access, or OAuth)
   - Each user gets their own DO instance + filesystem
   - Rate limiting per user

---

### Phase 4 (Future): Sandboxed Bash via just-bash

**Goal**: Give the agent a sandboxed shell environment for more complex tasks.

[just-bash](https://justbash.dev/) provides a pure-JS bash interpreter with
an `InMemoryFs`. The idea is to wire it to our `Volume` so the agent can run
shell commands against its own virtual filesystem.

#### Open Questions

- Can just-bash's `InMemoryFs` be replaced with a custom backend? The API
  shapes are similar to `@justfiles/fs` Volume but not identical — need an
  adapter.
- Performance: bash interpretation in a DO has CPU time implications. Complex
  scripts could hit the 30s/5min limit.
- Security: even sandboxed, need to restrict what commands are available.
  Limit to file manipulation, text processing, no network access.
- Alternative: instead of full bash, give the agent our `ghostore` CLI as a
  single tool. This is simpler and more controlled.

#### Tasks (tentative)

1. Test just-bash imports in Workers environment
2. Write an adapter: `Volume` → just-bash filesystem interface
3. Register a `bash` tool with the agent, backed by just-bash
4. Restrict available commands (allowlist)
5. Add CPU time monitoring and hard limits

---

## References

- [pi-mono repo](https://github.com/badlogic/pi-mono)
- [pi-agent-core README](https://github.com/badlogic/pi-mono/tree/main/packages/agent)
- [pi-ai README](https://github.com/badlogic/pi-mono/tree/main/packages/ai)
- [pi-coding-agent README](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
- [pi-web-ui](https://github.com/badlogic/pi-mono/tree/main/packages/web-ui) — web components for chat UI (potential reference)
- [pi issue #2395](https://github.com/badlogic/pi-mono/issues/2395) — ajv.compile() crash in Workers (fixed)
- [pi issue #2935](https://github.com/badlogic/pi-mono/issues/2935) — tool validation in Workers
- [pi issue #2616](https://github.com/badlogic/pi-mono/issues/2616) — SessionManager sync-only (open, blocking server mode)
- [pi issue #2737](https://github.com/badlogic/pi-mono/issues/2737) — RPC as first class citizen (architecture discussion)
- [pi issue #460](https://github.com/badlogic/pi-mono/issues/460) — server mode with WebSocket proposal
- [pi issue #1254](https://github.com/badlogic/pi-mono/issues/1254) — WebSocket support for server mode
- [CF Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [CF Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [CF Workers Node.js compat](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
- [CF WebSocket Hibernation API](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [CF Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [just-bash](https://justbash.dev/) — sandboxed bash in JS
- [@justfiles/fs](../../packages/fs/) — virtual filesystem abstraction
