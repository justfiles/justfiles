# Phase B review — `apps/desktop` vs `DESIGN.html`

Review of the `phase_b` branch against the requirements in `apps/desktop/DESIGN.html`
(slices 5–11 and the §9 communication-boundary / security invariants).

Status legend: 🔴 high · 🟠 medium · 🟢 low · ✅ fixed this session.

---

## 0. Already addressed this session

| # | Item | Status |
|---|------|--------|
| A | Built-in bundles imported via deep `../../../../packages/app-*/dist/bundle.js` relatives | ✅ → `@justfiles/app-*/bundle` package imports (scoped `app-counter`, added its `./bundle` export, kept embedded via `externalizeDeps.exclude`) |
| B | `nodeSandbox` (230 lines) duplicated frieren's Web-Worker protocol (R4 not done) | ✅ extracted `@justfiles/app/sandbox`; `nodeSandbox` 230→51, frieren `browserSandbox` 262→78, + node-worker integration test |
| C | app-code preview blank + no hot-reload | ✅ zero-height slot pinned (`[data-preview-slot]{height:100%}`); rebuilds re-import the gui in place with a cache-busting rev; redundant re-attaches de-duped |

Commit: `2daee86`.

---

## 1. 🔴 High — security & single-writer invariants — ✅ all fixed this session

### 1.1 ✅ No single-instance lock — breaks the "single writer" guarantee
`DESIGN.html` §9: *"one Volume on real disk, **single writer**."* There is no
`app.requestSingleInstanceLock()` anywhere in `src/main`. Two instances (a
double-launch, or relaunch before the prior process exits) means **two kernels
writing the same `nativeStorage` root** → corrupt `/state` and `/applications`.
For a hotkey-summoned background agent this is easy to hit.

- **Where:** `apps/desktop/src/main/index.ts` (`app.whenReady`).
- **✅ Fixed:** `requestSingleInstanceLock()` at startup; the loser calls
  `app.quit()` and the `whenReady` boot is guarded with `if (!gotLock) return`,
  so a second launch never boots a second kernel. `second-instance` summons the
  running launcher.

### 1.2 ✅ Renderers run `sandbox: false` — contradicts §9
§9: *"Renderers stay `sandbox: true`, `contextIsolation: true`, no
`nodeIntegration`."* All surfaces set `sandbox: false`:
`index.ts:111` (launcher), `:182` (app window), `:231` (agent window),
`preview.ts:73` (preview view). `contextIsolation`/`nodeIntegration` are fine
(defaults), but `sandbox:false` gives the preload full Node — it reads as the
electron-vite template default, not a deliberate choice. Apps load arbitrary
`app://` bundles, so this is exactly the surface the design wanted sandboxed.

- **✅ Fixed:** flipped all four surfaces to `sandbox: true`. Preload uses only
  `@electron-toolkit/preload` + `contextBridge`/`ipcRenderer` (no Node), and
  typecheck/tests pass; a manual app smoke-run is still worth doing since sandbox
  behaviour is runtime-only.

### 1.3 ✅ `nodeSandbox` workers never terminate — resource leak
frieren's `browserSandbox` has `terminateAppWorker(appId)`, called when an app's
last window closes. The desktop port dropped it: the `workers` map only evicts on
crash/exit (`nodeSandbox.ts:24`). Every distinct bundle launched keeps a live
`worker_thread` for the whole session — a steady leak in a long-running agent.

- **✅ Fixed:** added an app→worker map + `terminateAppWorker(appId)` (mirrors
  frieren); `index.ts` calls it when an app's last window closes, so distinct
  bundles no longer leak a live `worker_thread` per session.

---

## 2. 🟠 Medium — functional gaps vs design

### 2.1 ✅ `agent.abort()` permanently kills the agent
`agent.ts:90` — `await rt?.shutdown(); rt = null`, and `rt` is never rebuilt, so
after one Abort every later prompt falls to the *"runtime is unavailable"* branch
(`agent.ts:79`). Abort should cancel the current turn, not destroy the session.

- **✅ Fixed:** `abort()` now only cancels the in-flight turn (`rt.shutdown()`
  aborts the running agent) and no longer nulls `rt`; the dead "runtime
  unavailable" branch is gone, so later prompts keep working.

### 2.2 ✅ `reset` is plumbed but ignored
`devkit.run` forwards `reset` (`devkit.ts:40`) → `preview.run(..., reset)`, but
`preview.run` drops it (`preview.ts:46` `_reset`). frieren wipes
`/state/preview.<slug>.json` on reset (the ⟳ Run/Restart clean boot). So
app-code's "restart fresh" won't actually clear preview state on desktop.

- **✅ Fixed:** `reset` is honoured. `kernel.uninstall` already drops
  `/state/<id>.json`, but a same-code rebuild reuses the content-addressed worker
  that still holds (and re-persists) the old in-memory state — so on `reset`
  `preview.run` now `terminateAppWorker(previewId)` to force a clean cold-boot.

### 2.3 🟠 Preview menu bridge is a stub — *deferred*
`preview.menu`/`selectMenu` return `[]`/no-op. app-code renders a `Menubar`
wired to these, so the preview's live menubar is dead. §8.3/§10 call for wiring
`run`/`stop`/**menu**.

- **Deferred:** the desktop preview runs in a separate `WebContentsView` process
  and its gui mount doesn't use the browser runtime's menu mechanism, so this
  needs new cross-process plumbing (declare → report to main → answer `menu()` →
  route `selectMenu` back). Not a minimal change; left as a follow-up.

### 2.4 ✅ `ai` / `integrations` capabilities not registered
The registry has only `volume` + `devkit` (`index.ts:61`). Slice 8: *"ai/integrations
if keys present"*; §7 shows `ai: aiCapability(text)`. Any built-in needing `ai`
won't run, and the agent's LLM is a separate hardcoded path (see §3) rather than
the shared `ai` capability.

- **✅ Fixed:** registered `ai`, backed by the same local model the agent uses
  (`implementCapability(ai, …)` over `text(llmConfig())`, with `llmConfig` now
  exported from `agent.ts`), so a built-in declaring `ai` runs against one shared
  text generator. `integrations` stays unregistered — desktop has no keys ("if
  keys present").

### 2.5 🟠 Agent diverges from §6.3/§11.3 — see §3 for the deep-dive. *deferred*

---

## 3. The agent: reuse vs reimplement (§6.3 / §11.3) — *deferred*

> **Status:** deferred to a dedicated follow-up. Full reuse reshapes the shared,
> currently React-free `@justfiles/agent` package (adding a React peer dep + JSX
> build for the moved UI) and refactors the production frieren app over a
> `SocketLike` — out of scope for this minimal hardening pass. The current
> desktop agent stands as the explicit interim placeholder the recommendation
> below allows. The 2.1 abort fix and the `ai`-capability wiring (2.4) landed
> independently; making the model host config (step 5) lands with this work.

**Question:** the desktop hand-rolls its agent surface (a ~50-line `AgentView` in
`App.tsx` + a custom `agent.ts` with a direct-command parser, non-streaming
`prompt`, and a hardcoded local model). The design says reuse frieren's agent UI
over an injected `SocketLike`. Which is right?

### What I verified in the code
- frieren's agent UI is **already transport- and frieren-agnostic**:
  - `agent/Provider.tsx` (36 lines) — depends only on `useAgentClient` + React.
  - `agent/MessagesPanel.tsx` (228 lines) — depends only on its own hooks/types +
    an avatar asset. Grep for Clerk / react-router / `env.` / cloudflare coupling
    in `agent/**` and `os/client.ts`: **none**.
  - It's driven entirely by an `AgentClient` (`prompt`/`abort`/`subscribe`/`snapshot`),
    fed by a `SocketLike` (a plain `send`/`onmessage` WebSocket shape) — `os/client.ts:11`.
- The one real coupling: `AgentClient` is currently **bundled inside
  `createFrierenClient`** (`os/client.ts`, 431 lines) alongside frieren's
  app-catalog/sync/remote-window concerns. So the agent half needs extracting.
- The UI renders **streaming deltas, tool calls, and thinking blocks** (the
  `AgentEventFrame` protocol). The desktop's `AgentView` shows none of that — it
  prints final plain-text bubbles.

### Recommendation: **Reuse** (the current reimplementation is acceptable only as an explicit interim placeholder)

Reasoning:
1. **The desktop's UI is a strict downgrade.** Watching an agent *work* —
   streaming tokens, which tools it called, its reasoning — is the whole value.
   The hand-rolled `AgentView` structurally can't show any of it.
2. **The seam exists precisely for this.** The runtime (`@justfiles/agent`) is
   already shared; the `SocketLike` abstraction is the design's intended way to
   put the *same* UI over a different transport. Reusing completes a seam that's
   half-built, rather than forking the UX.
3. **One UX to maintain.** A second, inferior agent surface will drift from the
   real one; every agent feature then has to be built twice.
4. **The portability is real, not aspirational** — verified above. The extraction
   is mechanical, not a rewrite.

When *reimplement* would win (doesn't apply here): if desktop wanted a
fundamentally different, non-chat agent surface (e.g. a Spotlight-style inline
answer), or deliberately wanted to avoid a streaming transport. Neither is the case.

### Concrete work to reuse
1. **Extract** the agent half of `createFrierenClient` into a standalone
   `createAgentClient(socket: SocketLike)`, and move it + `Provider` + `MessagesPanel`
   + `agent/hooks` + `agent/types` into **`@justfiles/agent/client`** (the design
   literally says *"its client half can move to `@justfiles/agent/client` so the WS
   and IPC hosts share it"*).
2. **Refit frieren** so `createFrierenClient` composes `createAgentClient` over its
   WebSocket and imports the UI from the package (guarded by its existing agent tests).
3. **Desktop main:** forward the `@justfiles/agent` runtime's streaming events as
   `event` frames over an IPC-backed `SocketLike` (the runtime already streams —
   `agent.ts` currently just awaits the final string). 
4. **Desktop renderer:** inject the IPC `SocketLike`
   (`send` → `ipcRenderer.send`, `onmessage` ← `webContents.send('agent:event', …)`),
   build `createAgentClient(socket)`, render `<AgentProvider><MessagesPanel/></AgentProvider>`.
5. **Delete** the bespoke `AgentView` and the `agent.ts` direct-command parser
   (the agent's bash `app` command already covers `app list/launch/run`, so the
   parser is redundant) and make the model **host config**, not a hardcoded
   LM-Studio constant (`agent.ts:166`).

**Cost vs payoff:** the real cost is the streaming IPC bridge (step 3). Everything
else is moving files and composing. The payoff is the desktop gets frieren's full
streaming/tool-call agent UX for free, forever.

---

## 4. 🟢 Low — cleanup / minor divergence

- **Preview installs into the main kernel**, not §8.3's *"scratch-scoped kernel"* —
  `preview.*` lands in the real `/applications` + `/state` on disk (filtered from
  lists, removed on `stop`, but **left stale if the app crashes mid-preview**).
- **`openAppWindow` never dedups** — `app launch X` twice opens two windows of the
  same app rather than focusing the existing one.
- **gui-load errors render as raw text** in `.app-host` (`App.tsx`) — fine for dev,
  rough for users.
- **Optional, expected-missing:** OS `fs.watch` → `caps.subscribe` for external
  edits (§4, explicitly optional) is not wired.

---

## 5. What's solid

The core mapping is faithful and clean: single kernel + native Volume +
`nodeSandbox` + `app://` protocol + IPC GUI transport + in-process
`capabilityRegistry` + agent in main + devkit install-to-disk all match §3–§8.
The R4 sandbox extraction now matches §11.4. Overall adherence to the design is
strong; the gaps above are hardening and completeness, not architectural misses.

---

## 6. Suggested order

1. ✅ **§1.1 single-instance lock** + **§1.3 worker termination** — small, protect
   invariants the design leans on.
2. ✅ **§1.2 `sandbox: true`** — verify-and-flip hardening.
3. ✅ **§2.1 abort** + **§2.2 reset** — small correctness fixes. (Plus ✅ **§2.4 `ai`**.)
4. **§3 agent reuse** + **§2.3 menu bridge** — *deferred.* The largest, but the
   right direction; can land after a tracer-bullet `@justfiles/agent/client`
   extraction.

**This session (uncommitted):** §1.1, §1.2, §1.3, §2.1, §2.2, §2.4 — 4 files in
`apps/desktop/src/main`, +75/−34. `format`/`typecheck`/`lint` clean, 681/681 tests
pass. Deferred: §2.3, §2.5/§3.
