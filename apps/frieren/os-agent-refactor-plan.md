# Frieren OS/Agent/Shell refactor plan

## Context

Frieren's frontend grew from a chat-first UI into a small desktop OS shell:

- window state, focus order, fullscreen mode, and app lifecycle live in the client;
- app GUI hosting is imperative and must be tied to the OS lifecycle;
- the agent/messages surface is an OS feature, not the whole app;
- legacy names (`ChatPage`, `useChat`, `ChatProvider`, `kernelAppHost`, `KernelAppSlot`, `chatOpen`) obscure the current architecture.

The desired architecture has clear levels:

1. **OS layer**: client-side operating environment. Owns persisted shell/window state, app host lifecycle, volume-backed state persistence, app catalog, app launch/install/uninstall commands, and the shared Frieren websocket client.
2. **Agent layer**: LLM/messages feature. Owns agent session UI state and talks to the server through an `AgentClient` abstraction supplied by OS infrastructure.
3. **Shell/display layer**: React desktop UI: menubar, desktop icons, windows, context menus.
4. **Apps layer**: app catalog types and imperative app GUI hosting. Avoid `kernelApps` naming in frontend even if wire protocol still says `kernel_app_*`.

## Agreed decisions

- Use **two providers**, not one giant provider:
  - `os/Provider.tsx`: OS infra and lifecycle.
  - `agent/Provider.tsx`: agent session/messages.
- Provider hierarchy:

  ```tsx
  <OSProvider>
    <AgentProvider>
      <DesktopShell onSwitchUser={requestSwitchUser} />
    </AgentProvider>
  </OSProvider>
  ```

- `OSProvider` owns:
  - Clerk token access;
  - user volume creation;
  - OS store creation and boot;
  - app host lifecycle;
  - app catalog and app commands;
  - shared Frieren websocket connection;
  - concrete websocket-backed clients, including `AgentClient`.
- `AgentProvider` owns:
  - agent messages;
  - input state;
  - streaming state;
  - displayed participant names;
  - agent session actions exposed to UI.
- `AgentProvider` receives/uses an `AgentClient`; it must not know raw websocket frame details.
- Keep contexts narrow:
  - OS context should hold stable store/client/service objects, not selected mutable state.
  - Components should subscribe through selector hooks such as `useOsStore(selector)`.
  - Agent state can be exposed through agent-specific hooks.
- Rename `assistant` concepts to **agent**.
- Rename frontend `kernelApp*` concepts to **app** concepts.
- Leave server routes/protocol names unchanged for now (`kernel_app_open`, `kernel_app_close`, `/api/kernel/...`). Add comments/TODOs where frontend still speaks that legacy protocol.
- OS/client owns full window state and persists it to volume. If the server needs this information later, it should read the OS state file instead of maintaining an independent durable open-app list.
- App host lifecycle is part of `OSProvider` lifecycle, including boot restoration and cleanup.
- Agent surface open state belongs in OS state as `agentOpen`.
- Agent window rect stays session-local for now unless there is clear user value in persisting it.
- Product has not shipped, so do not spend effort on old `chatOpen` snapshot migration. Update the persisted schema directly and let invalid old snapshots fall back to fresh state.
- App window title should be derived from app metadata/catalog. Persist `appId` and window geometry/mode/focus; use persisted title only as a temporary fallback if it remains during transition.
- Use TDD for test-friendly changes: write/update focused reducer/selector/client/effect tests before changing implementation.

## Non-goals for this refactor

- Do not rename worker protocol frames/routes in the same pass.
- Do not redesign app runtime internals beyond moving/renaming frontend host adapter files.
- Do not introduce a generic event bus unless concrete needs appear.
- Do not add new persistence formats unless needed for compatibility.

## Target layout

```txt
apps/frieren/src/
  App.tsx

  shell/
    DesktopShell.tsx
    DesktopIcons.tsx              # optional extraction if useful
    MenubarStatus.tsx             # optional extraction if useful

  os/
    Provider.tsx                  # exports OSProvider
    hooks.ts                      # useOsStore/useOsDispatch/useOsClient/etc.
    client.ts                     # shared Frieren websocket client
    state.ts
    reducer.ts
    selectors.ts
    store.ts
    effects.ts
    persistence.ts
    window/
      WindowFrame.tsx             # current components/Window.tsx
      ApplicationWindow.tsx       # current os/AppWindow.tsx

  agent/
    Provider.tsx                  # exports AgentProvider
    hooks.ts                      # useAgentSession/useAgentConnection
    types.ts
    MessagesPanel.tsx

  apps/
    host.ts                       # current kernelAppHost.ts
    AppViewport.tsx               # current KernelAppSlot.tsx
    types.ts                      # InstalledApp/catalog types
```

Notes:

- `os/Provider.tsx` is React/runtime composition, but lives under `os/` because it owns OS lifecycle.
- Keep pure OS pieces (`state`, `reducer`, `selectors`) free of React/runtime dependencies.
- Keep display-only shell components under `shell/`.

## Client abstraction

Raw websocket ownership should not force merging OS and Agent providers.

Create a concrete shared client owned by `OSProvider`, for example `FrierenClient` in `os/client.ts`. It owns the websocket and routes server frames to small domain clients.

Minimal shape:

```ts
interface AgentClient {
	prompt(text: string): void
	abort(): void
	subscribe(listener: AgentListener): () => void
	snapshot(): AgentSnapshot
}

interface AgentSnapshot {
	connectionState: ConnectionState
	userName: string
	agentName: string
	history: AgentMessage[]
}
```

Possible OS/app-facing surface:

```ts
interface FrierenClient {
	connect(): void
	close(): void
	agent: AgentClient
	openApp(id: string): void
	closeApp(id: string): void
	subscribeApps(listener: (apps: InstalledApp[]) => void): () => void
	subscribeRemoteWindow(listener: (event: RemoteWindowEvent) => void): () => void
}
```

Rules:

- Keep it concrete to Frieren. Do not build a generic bus.
- `OSProvider` creates it once per signed-in user/session.
- `AgentProvider` consumes only `AgentClient`.
- Use the common external-store/observable-cache pattern used by React stores, query clients, Apollo/urql-style clients, and RxJS `BehaviorSubject`: keep a small replayable current snapshot plus subscriptions. Do **not** buffer an unbounded raw websocket event log.
- `AgentClient.snapshot()` returns durable/latest state: connection state, participants, and restored history. `subscribe()` delivers future domain events. AgentProvider should subscribe and then read/apply `snapshot()` (or use a `useSyncExternalStore`-style helper) so a `ready/history` frame cannot be missed between render and effect.
- Streaming deltas do not need pre-provider buffering because user prompts originate from AgentProvider after it is mounted. If a future server feature can stream agent events before the provider is mounted, add a bounded event queue then.
- `ready/history/event/error/debug` parsing can live in the client; AgentProvider receives domain events/snapshots.
- `ready.apps` and legacy `kernel_app_*` frames are routed to OS/app handling.

## Persistence rules

OS state is the authoritative client-side shell state, so persistence should not rely only on page unload.

Rules:

- Write discrete durable changes immediately or near-immediately: app open/close, fullscreen/mode changes, focus/order changes if persisted, and `agentOpen`.
- Debounce only high-frequency geometry changes if they become high-frequency. Current `WindowFrame` commits rect on pointer-up, so rect writes can also be prompt.
- Add a flush path for any pending debounced write and call it on:
  - `pagehide`;
  - `visibilitychange` when hidden;
  - `OSProvider` unmount.
- Treat unload/pagehide writes as best-effort only. The primary safety comes from prompt writes on committed state changes.
- Keep persistence implementation behind OS store/effects; UI components should only dispatch OS actions.

## Naming map

| Current                  | Target                                                    |
|--------------------------|-----------------------------------------------------------|
| `ChatPage`               | `DesktopShell`                                            |
| `useChat`                | split into OS provider/client + Agent provider hooks      |
| `ChatProvider`           | `AgentProvider` for messages; `OSProvider` for OS/runtime |
| `useChatSession`         | `useAgentSession`                                         |
| `chat/types.ts`          | split into `agent/types.ts` and `apps/types.ts`           |
| `MessagesPanel`          | `agent/MessagesPanel`                                     |
| `Window`                 | `WindowFrame`                                             |
| `AppWindow`              | `ApplicationWindow`                                       |
| `KernelAppSlot`          | `AppViewport`                                             |
| `kernelAppHost.ts`       | `apps/host.ts`                                            |
| `kernelAppHost` variable | `appHost`                                                 |
| `chatOpen`               | `agentOpen`                                               |
| `chat.setOpen`           | `agent.setOpen`                                           |
| `selectChatOpen`         | `selectAgentOpen`                                         |

## Slice 1 — Pure renames/moves for shell display

Goal: replace chat-root naming without changing behavior.

Steps:

1. Move `ChatPage.tsx` to `shell/DesktopShell.tsx`.
2. Rename component `ChatPage` -> `DesktopShell`.
3. Update `App.tsx` import/render.
4. Keep existing `useChat`/`ChatProvider` temporarily so this slice is mechanical.

Verification:

- `pnpm typecheck`
- Open Frieren and confirm desktop still renders.

Notes:

- This slice should not touch provider logic.
- It gives an immediate semantic improvement with low risk.

## Slice 2 — Rename app host frontend files

Goal: remove frontend `kernelApp` naming while preserving wire protocol.

Steps:

1. Move `kernelAppHost.ts` -> `apps/host.ts`.
2. Move `KernelAppSlot.tsx` -> `apps/AppViewport.tsx`.
3. Rename `KernelAppSlot` -> `AppViewport`.
4. Rename local imports/variables from `kernelAppHost` to `appHost`.
5. Update comments to say "app" or "guest app".
6. Add a short comment near protocol sends explaining that `kernel_app_*` is legacy wire naming and intentionally unchanged for compatibility.

Verification:

- `pnpm typecheck`
- Launch an installed app; close it; relaunch it.

Notes:

- Do not touch worker protocol/routes in this slice.
- `host.ts` should still export the same lifecycle surface initially: `open`, `close`, `wrapperOf`.

## Slice 3 — Introduce OSProvider with OS store context

Goal: stop passing `store` through display components and establish OS lifecycle owner.

Steps:

1. Create `os/Provider.tsx`, exporting `OSProvider`.
2. Move OS store creation and `bootOsStore` call out of legacy `useChat` into `OSProvider`.
3. Create `os/hooks.ts` with narrow hooks:
   - `useOsStore(selector, equal?)`
   - `useOsDispatch()`
   - `useAgentClient()` or `useOsClient()` for stable client access.
4. Wrap the desktop in `OSProvider` from `App.tsx` or a near-root shell component.
5. Update `DesktopShell` and `ApplicationWindow` to use OS hooks instead of receiving `store` prop.

Verification:

- `pnpm typecheck`
- Window drag/resize/focus still works.
- Confirm moving one window does not force all app windows to re-render unnecessarily. Use existing per-window selector pattern.

TDD/tests:

- OS hooks throw a clear error outside provider;
- `useOsStore` selectors can subscribe without prop-drilling the store.

Notes:

- Context should hold the stable store/client objects, not selected state.
- Keep selectors with `@justfiles/state/react` to avoid broad context rerenders.

## Slice 4 — Introduce shared Frieren client and AgentClient

Goal: resolve websocket ownership cleanly without merging providers.

Steps:

1. Create `os/client.ts`.
2. Move raw websocket connection logic from legacy `useChat` into a concrete `FrierenClient`.
3. Give `FrierenClient` an `agent` client with:
   - `prompt(text)`;
   - `abort()`;
   - `subscribe(listener)`;
   - `snapshot()`.
4. Route agent frames (`history`, `event`, relevant `error/debug`, participants, connection state) through `AgentClient`.
5. Route app/OS frames (`ready.apps`, `kernel_app_open`, `kernel_app_close`) to OS/app handlers.
6. Ensure `snapshot()` prevents missing early `history`/`ready` frames before `AgentProvider` subscribes.

TDD/tests:

- client snapshot receives `ready/history` before subscription and AgentProvider/client consumer can still hydrate from snapshot;
- subscription receives future agent events;
- no unbounded buffering is required for normal prompt-driven streaming.

Verification:

- Connect/reconnect works.
- App catalog still appears after ready.
- History and participants still hydrate agent session.
- Agent streaming events still arrive.

Notes:

- Do not create a generic event emitter abstraction unless unavoidable.
- Keep websocket protocol compatibility names hidden inside `os/client.ts` as much as possible.

## Slice 5 — Integrate app host lifecycle into OSProvider

Goal: make app GUI host lifecycle a first-class OS lifecycle concern.

Steps:

1. Add `closeAll()` to `apps/host.ts`.
2. In `OSProvider`, register cleanup on unmount:
   - close `FrierenClient`;
   - call `appHost.closeAll()`.
3. Ensure `OSProvider` wires app host into OS store effects:
   - app open action calls `appHost.open`;
   - window close action calls `appHost.close`;
   - user-originated app open/close still sends legacy `kernel_app_*` frames through `FrierenClient` while remote/boot-originated actions do not loop.
4. Add boot restoration behavior: after persisted OS state loads, app host stages are opened for every restored app window.

TDD/tests:

- boot-loaded/restored windows open app host stages;
- boot restoration does not send legacy `kernel_app_open`;
- provider cleanup calls `appHost.closeAll()`.

Verification:

- Refresh page with an app window open; restored window should show live app GUI, not an empty viewport.
- Sign out/switch user; ensure previous app GUI DOM is not retained.
- Launch/close app multiple times without duplicate wrappers.

Notes:

- Boot restoration should not emit `kernel_app_open` back to the server.
- Restore immediately using fallback `/api/kernel/{id}/gui.js` if catalog metadata is not loaded yet. Catalog arrival can improve icon/title metadata, but restored app GUI should not wait on it.

## Slice 5b — Make OS persistence flushable

Goal: avoid losing authoritative OS state on refresh/sign-out/unmount.

Steps:

1. Make the persist effect/controller expose a `flush()` for pending writes, or otherwise make committed durable actions write promptly.
2. Write app open/close, mode, and `agentOpen` promptly.
3. Debounce only geometry if necessary.
4. Call flush on `pagehide`, `visibilitychange:hidden`, and `OSProvider` unmount.

TDD/tests:

- discrete durable action schedules/writes promptly;
- pending debounced write is flushed when flush is called;
- repeated unchanged state does not rewrite.

Verification:

- Open/move a window, immediately refresh, and confirm state is retained.

## Slice 6 — Client-owned OS state vs server open-app compatibility

Goal: eliminate competing durable sources of truth while preserving compatibility during the refactor.

Current issue:

- Client OS snapshot persists `windows/openOrder/focusStack`.
- Worker also persists `open_kernel_apps` and replays `kernel_app_open` on websocket connect.

Decision:

- Client OS state is authoritative for window state.
- Server should not maintain a separate durable open-app list long-term.
- If server/agent needs open-window info, it should read the OS state file from volume.

Short-term compatibility steps:

1. Keep handling server `kernel_app_open/close` frames as remote actions.
2. Keep sending user app open/close to server for now.
3. On client boot, restored windows mount locally and do not rely on server replay.
4. Treat replayed remote opens for windows that already exist as no-ops: do not refocus, do not overwrite metadata, do not re-open host stages.
5. Add comments marking server open IDs as legacy compatibility.

Later cleanup steps:

1. Stop worker from persisting `open_kernel_apps`.
2. Stop replaying open IDs on websocket connect.
3. Keep protocol only as live sync/command channel if still needed.
4. Add server-side read of OS state file only when the agent/server needs open-window information.

TDD/tests:

- remote open for an already-restored window is a no-op and does not change focus;
- remote open for a missing window still opens it;
- remote close still closes it.

Verification:

- Refresh page: client-restored windows survive regardless of server replay.
- Open/close from current UI still works.
- Existing remote open/close events from server still work during compatibility period.

Notes:

- Do not remove worker persistence until the frontend is stable.

## Slice 7 — Split AgentProvider out of legacy useChat

Goal: make agent/session state separate from OS state.

Steps:

1. Create `agent/types.ts` for:
   - `AgentMessage`
   - `ToolCallInfo`
   - `AgentSession`
   - `AgentConnection`
   - `AgentClient` if not defined in `os/client.ts`.
2. Create `agent/Provider.tsx`, exporting `AgentProvider`.
3. Move message/input/streaming/userName/agentName state from `useChat` into `AgentProvider`.
4. Have `AgentProvider` consume `AgentClient` from OS hooks.
5. Create `agent/hooks.ts`:
   - `useAgentSession()`
   - `useAgentConnection()`
6. Move `chat/MessagesPanel.tsx` -> `agent/MessagesPanel.tsx` and update it to use agent hooks.
7. Rename comments from assistant/chat to agent/messages.

Verification:

- Send a message; receive stream/tool-call updates.
- Abort still works.
- History restore still works.
- Messages window opens/closes without affecting app windows.

Notes:

- AgentProvider must not create or own the raw websocket.
- AgentProvider must not own installed app catalog or app launch commands.

## Slice 8 — Extract app catalog/launcher domain

Goal: stop `Launcher` from living in agent/chat types.

Steps:

1. Move `InstalledApp` and launcher/catalog types to `apps/types.ts`.
2. Make `OSProvider` own installed app catalog because app launch/install/uninstall are OS-level actions.
3. Expose narrow hooks from OS/apps side:
   - `useInstalledApps()`
   - `useAppCommands()` returning `launchApp`, `installApp`, `uninstallApp`.
4. Move `pickZipFile`, install, uninstall, and catalog refresh/reconnect logic out of agent session code.
5. Update desktop icons/context menu to use app hooks.

Verification:

- App list appears after connection/ready.
- Install app from zip still refreshes app catalog.
- Uninstall closes open app window first and removes app from catalog.

TDD/tests:

- app window title is derived from installed app catalog metadata when available;
- missing catalog metadata falls back gracefully to persisted title/app id during boot.

Notes:

- If catalog refresh still uses websocket reconnect, hide that behind `FrierenClient.refresh()` or a small OS command. Do not leak raw ws to UI.
- Long-term, do not persist fixed app window titles as source of truth; derive from app metadata.

## Slice 9 — Rename OS agent window state

Goal: remove `chatOpen` from OS state naming.

Steps:

1. Rename OS state field `chatOpen` to `agentOpen`.
2. Rename action `chat.setOpen` to `agent.setOpen`.
3. Rename selector `selectChatOpen` to `selectAgentOpen`.
4. Update reducer/selectors tests.
5. Keep agent window rect session-local in `DesktopShell` for now.
6. Update persistence validation/schema directly; no migration/backward compatibility needed before ship.

TDD/tests:

- `agent.setOpen` flips the flag and repeat dispatch is a no-op reference;
- `selectAgentOpen` returns the flag;
- fresh persisted schema validates.

Verification:

- Existing reducer/selectors tests pass.
- Agent/messages window toggle still works.

Notes:

- Persisting `agentOpen` is acceptable because it is shell surface state.
- Do not persist agent window rect yet.
- Do not add `chatOpen` migration code.

## Slice 10 — Remove legacy chat module

Goal: delete the transitional `chat/` module once responsibilities are moved.

Steps:

1. Remove `chat/useChat.ts`.
2. Remove or move `chat/types.ts`.
3. Move `chat/agent-avatar.png` to `agent/agent-avatar.png`.
4. Remove empty `chat/` directory.
5. Run repo-wide search for old names:
   - `ChatPage`
   - `useChat`
   - `ChatProvider`
   - `useChatSession`
   - `kernelAppHost`
   - `KernelAppSlot`
   - `chatOpen`
   - `chat.setOpen`
   - `assistant`

Verification:

- `pnpm typecheck`
- `pnpm lint:fix`
- Smoke test desktop, agent message, app launch/close.

## Later protocol cleanup

Not part of this refactor.

When ready, rename frontend and worker protocol/routes/storage keys together:

- `kernel_app_open` -> `app_open`
- `kernel_app_close` -> `app_close`
- `/api/kernel/:id/...` -> maybe `/api/apps/:id/...`
- remove or rename `OPEN_KERNEL_APPS_STORAGE_KEY` depending on whether server durable open-app state still exists.

## Final verification checklist

After all slices:

```sh
pnpm format
pnpm typecheck
pnpm lint:fix
pnpm test
```

Frieren smoke checks:

- sign in/onboarding path still reaches desktop;
- app icons render;
- app launch/close/focus/fullscreen/drag/resize works;
- refresh restores persisted app windows and mounts their GUI;
- agent messages open/close works;
- sending/streaming/abort/history work;
- install/uninstall app still works;
- user switch/sign-out does not leak old app GUI DOM.
