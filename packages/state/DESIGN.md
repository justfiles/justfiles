# `@justfiles/state` design

## Goal

Create a small framework-neutral state package that can back both:

- kernel apps: durable semantic app state, action handlers, queries, capability-backed async work.
- Frieren OS shell: durable window/session state, selectors, persistence, and browser-side effects.

Keep the package minimal. It should not become a Redux/Zustand clone.

## What the existing apps teach us

Existing `@justfiles/app` apps already follow a strong state discipline:

- App state is durable and semantic.
	- Files persists `currentViewing`, `files`, `loading`, `error`.
	- Paint persists `tool`, `size`, `color`, save status.
	- Crossword persists puzzle/play state.
- Transient UI state stays outside reducer state.
	- Files preview text is GUI-local because file bytes can change.
	- Paint canvas pixels, drag state, undo/redo, and `busy` are GUI-local.
	- Crossword input draft and temporary call errors are GUI-local.
- Actions can be async.
	- Files `refresh` scans volume.
	- Paint `save` writes PNG bytes.
	- Settings talks to integrations.
	- Crossword calls AI.
- Queries read without persisting.
	- Files `readFile` returns preview bytes but does not store them.
- Current app dispatch is atomic from the GUI's point of view.
	- A handler receives current state, awaits capabilities, returns the next state, then the kernel persists and broadcasts it.

The OS shell has the same durable-state need, but adds two requirements the app runtime does not currently have:

- selector subscriptions, so moving/focusing one window does not rerender unrelated windows.
- local effects, because opening/closing/focusing windows must also talk to `kernelAppHost`, websocket, and persistence.

## Core terms

- **State**: JSON-serializable durable data.
- **Action**: serializable event/command input.
- **Reducer**: pure function `(state, action) => state`.
- **Effect**: non-serializable work triggered after a state transition: filesystem writes, websocket sends, DOM/kernel host calls.
- **Selector**: function from state to a smaller value for subscriptions/rendering.

"Mutation" and "Query" appear in `@justfiles/app`'s app-handler model and are not used by this store.

## Package shape

```txt
packages/state/
	package.json
	index.ts
	react.ts
	store.test.ts
```

Public exports from `@justfiles/state`:

```ts
export type MaybePromise<T> = T | Promise<T>
export type Unsubscribe = () => void

export interface Store<State, Action> {
	getState(): State
	dispatch(action: Action): void
	subscribe(listener: () => void): Unsubscribe
}
```

Public exports from `@justfiles/state/react`:

```ts
export function useStore<State, Action, T>(
	store: Store<State, Action>,
	selector: (state: State) => T,
	equal?: (a: T, b: T) => boolean
): T
```

The React adapter is optional. The state package core must not import React.

Notes on the minimal surface:

- No `replaceState`. Boot-time hydration is just an action (`{ type: 'boot/loaded'; state }`) dispatched after the persisted snapshot loads. Keeps every state transition observable by effects and reducers; no second mutation path.
- No `subscribeSelector` on the core. The React adapter is built on `useSyncExternalStoreWithSelector` from `use-sync-external-store/shim/with-selector` — `useSyncExternalStore` alone requires `getSnapshot` to return a stable reference, which would forbid derived-object selectors (`selectOpenWindows`, etc.). The `with-selector` variant caches the last `(state, selectedValue)` pair and runs the equality check, so selectors can freely return new objects. Add a non-React selector subscription only when a non-React caller actually needs one.

## Store model

The OS shell should use a pure reducer plus effects:

```ts
export type Reducer<State, Action> = (state: State, action: Action) => State

export type EffectContext<State, Action> = {
	getState(): State
	dispatch(action: Action): void
}

export type Effect<State, Action> = (
	action: Action,
	previous: State,
	next: State,
	ctx: EffectContext<State, Action>
) => MaybePromise<void>

export function createStore<State, Action>(options: {
	initialState: State
	reducer: Reducer<State, Action>
	effects?: readonly Effect<State, Action>[]
}): Store<State, Action>
```

Rules:

- `reducer` is pure and synchronous.
- `dispatch` is synchronous and run-to-completion: for each action, the reducer runs, then (if state changed) subscribers are notified, then each effect's synchronous portion runs to completion before the next action is processed.
- if the reducer returns the same state reference (`Object.is(prev, next)`), neither subscribers nor effects fire. Effects can therefore trust that `previous !== next`.
- effects run in registration order, after subscriber notification. Each effect is invoked sequentially; its return value is not awaited before the next effect runs or before `dispatch` returns. Async effects detach at their first `await`.
- re-entrant `dispatch` calls (from a subscriber or from inside an effect's sync portion) are queued FIFO and processed before the outer `dispatch` returns. They are not recursive — every effect always sees the `previous`/`next` pair that triggered it, never a half-applied state from a nested dispatch.
- effect failures do not roll back state; they should dispatch explicit failure actions when needed. Unhandled effect errors are logged to `console.error`.

No `Env` generic. Effects close over whatever they need (kernel host, websocket, persistence handle) at the call site that builds the effect list — e.g. `const effects = [makeOpenEffect({ kernelAppHost, socket })]`. The store stays generic over only `State` and `Action`.

This gives the OS a clean split:

- reducer owns durable facts: windows, rects, focus stack, modes, `chatOpen`.
- effects own non-serializable work: `kernelAppHost.open`, websocket sends, debounced persistence.

## Async actions

Current app handlers are async mutations. For `@justfiles/state`, async work should be modelled as effects for live local stores.

Example OS launch:

```ts
type OsAction =
	| { type: 'app.open'; appId: string }
	| { type: 'app.openFailed'; appId: string; message: string }

function osReducer(state: OsState, action: OsAction): OsState {
	switch (action.type) {
		case 'app.open':
			return openWindowAndFocus(state, action.appId)
		case 'app.openFailed':
			return recordWindowError(state, action.appId, action.message)
	}
}

function makeOpenEffect(env: {
	kernelAppHost: typeof import('../kernelAppHost')
	socket: WebSocket
}): Effect<OsState, OsAction> {
	return async (action, _prev, _next, ctx) => {
		if (action.type !== 'app.open') return
		try {
			env.kernelAppHost.open(action.appId)
			env.socket.send(JSON.stringify({ type: 'kernel_app_open', id: action.appId }))
		} catch (error) {
			ctx.dispatch({
				type: 'app.openFailed',
				appId: action.appId,
				message: error instanceof Error ? error.message : String(error)
			})
		}
	}
}
```

For existing kernel apps, keep the current atomic async handler semantics. `@justfiles/app` already has its own `Context.setState` model; no shared helper is needed until duplication actually appears. OS state and app state have different runtime needs.

## OS state shape

Initial target for Frieren:

```ts
export type WindowRect = { x: number; y: number; w: number; h: number }

export type WindowMode = 'floating' | 'minimized' | 'fullscreen'

export type OsWindow = {
	id: string
	appId: string
	title?: string
	rect: WindowRect
	mode: WindowMode
}

export type OsState = {
	version: 1
	booted: boolean       // false in initial state; true after `boot/loaded`
	windows: Record<string, OsWindow>
	openOrder: string[]   // insertion order, stable — drives render iteration
	focusStack: string[]  // last element is focused; closing pops normally
	chatOpen: boolean
}
```

Modeling notes:

- `OsWindow` is app-windows only. System surfaces like the chat panel are *not* windows (see below); no `kind` discriminator is needed.
- Fullscreen is a per-window `mode`, following macOS semantics — multiple windows may be `fullscreen` in state, but only the top fullscreen window in `focusStack` is visible. The renderer derives "what's covering the desktop right now" via a selector rather than a separate `fullscreenId` field on state. Closing a fullscreen window just pops `focusStack`; the new top determines what's visible next.
- Minimized windows stay in both `openOrder` and `focusStack` (the app is still running), but the renderer skips them. They're not focusable until restored.
- `openOrder` and `focusStack` are intentionally separate. `openOrder` drives stable JSX child ordering (so React doesn't unmount/remount windows when focus changes); `focusStack` drives z-index and the visible-fullscreen selector.

Reducer invariants — every transition must preserve:

- every id in `openOrder` and `focusStack` exists as a key in `windows`.
- no duplicates in `openOrder` or `focusStack`.
- opening a window appends to both `openOrder` and `focusStack` (top).
- closing a window removes it from `windows`, `openOrder`, and `focusStack`.
- focusing pushes/moves to the top of `focusStack`; `openOrder` is never reordered.

Derived selectors:

```ts
selectBooted(state)                 // gates the loading screen in App.tsx
selectOpenWindows(state)            // ordered by openOrder
selectFocusedWindowId(state)        // last element of focusStack, or null
selectWindow(state, id)
selectWindowZIndex(state, id)       // rank in focusStack
selectVisibleFullscreenId(state)    // top-down walk of focusStack, first fullscreen
selectChatOpen(state)
```

### System surfaces (chat, future overlays)

Chat is an OS-level surface but is not a window — it lives outside `OsState.windows`. For now that's a single boolean:

```ts
chatOpen: boolean
```

When a second system surface arrives (e.g. spotlight, notification center), promote to an `overlays: { chat: boolean; spotlight: boolean }` record. Until then, the flat boolean stays. Each overlay owns its own input model, dismissal behavior, and positioning — none of which fits into `OsWindow`'s rect/focus/z-order shape.

If chat ever genuinely needs to be windowable (user drags it around like an app), it becomes a real `OsWindow` and the overlay flag disappears. Don't pay for that flexibility now.

Do not store:

- DOM nodes.
- websocket objects.
- auth/session objects.
- volume handles.
- React elements.
- `kernelAppHost` stages.
- drag-in-progress refs.

## Persistence

Persistence is an OS effect, not part of the store core.

### Boot

1. On Frieren boot, read `/system/os-state.json` from the user volume.
2. Validate `version` and shape; on any failure, fall back to `initialState` (do not throw — a corrupt snapshot should not brick the shell).
3. Reconcile with the installed-apps list from the launcher: drop windows whose `appId` is no longer installed.
4. Dispatch `{ type: 'boot/loaded', state: { ...restored, booted: true } }`. The reducer overwrites state with the payload; `booted: true` is enforced here (not trusted from disk) so a missing/false value in the file can't leave the shell stuck on the loading screen.
5. The `App.tsx` loading screen gates on `useStore(store, selectBooted)` rather than external React state — the store is self-describing about boot status.

Initial state has `booted: false`. No user interaction is possible while the loading screen renders, so there's no race against user-dispatched actions.

### Write — debounced and content-checked

The persistence-write effect runs on every dispatched action and applies two gates:

```ts
let lastWritten: string | null = null
const writeNow = debounce(async (state: OsState) => {
	const serialized = JSON.stringify(state)
	if (serialized === lastWritten) return
	await volume.writeFile('/system/os-state.json', encoder.encode(serialized))
	lastWritten = serialized
}, 300, { maxWait: 2000 })

const persistEffect: Effect<OsState, OsAction> = (_action, _prev, next) => {
	if (!next.booted) return        // gate 1: no writes before/during boot
	writeNow(next)                  // gate 2: debounced + string-equality
}
```

- **`booted` gate** stops the `boot/loaded` dispatch itself from triggering a write that just round-trips the bytes we read.
- **Trailing-edge debounce** (~300ms) coalesces bursts — arranging several windows, opening + immediately closing an app, rapid focus changes — into one write. `maxWait` ~2s bounds data loss if the user keeps generating events continuously.
- **String-equality check** suppresses no-op writes the reducer couldn't catch: e.g. a sequence of actions whose final serialized form equals the last persisted form. We're already paying for `JSON.stringify` to write to disk; comparing the resulting strings is cheaper, simpler, and more correct than a hash (no collision risk, no algorithm choice).
- **Boot initialization of `lastWritten`**: in the boot effect, set `lastWritten = serializedBytesFromDisk` *before* dispatching `boot/loaded`. Belt-and-braces — even if the `booted` gate is ever bypassed, the equality check still skips the round-trip.

### Stability of `JSON.stringify`

`JSON.stringify` preserves object property insertion order. If a reducer ever rebuilds `windows` with shifted key order (e.g. `{ ...rest, [id]: w }` after a delete-readd), the serialized string differs even though the state is semantically identical, causing a spurious write.

Start naive: keep reducers careful about object construction order. If spurious writes show up in dev (easy to spot — log each `volume.writeFile`), upgrade to a stable stringifier (sort keys recursively). Don't pre-pay for this until observed.

### Migration

The product has not shipped. Ignore any old per-window files at `/applications/:appId/window.json` and stop writing them.

## How `@justfiles/app` should reuse this

Do not move all of `@justfiles/app` into `@justfiles/state`.

Keep app-specific pieces in `@justfiles/app`:

- schema metadata.
- capability declarations.
- sandbox runtime.
- agent-visible action descriptions/examples.
- bundle/manifest handling.
- typed GUI client transport.

Extract only generic pieces when they are proven useful:

- `MaybePromise`.
- mutation/query execution helpers.
- maybe state snapshot validation/migration helpers later.

The shared package should be a deep module with a small interface. If extracting a helper makes `@justfiles/app` harder to read, do not extract it.

## Implementation steps

### Step 1: Create package skeleton

- Add `packages/state/package.json`.
- Add `packages/state/index.ts`.
- Add `packages/state/react.ts`.
- Add typecheck script.

Acceptance:

- package imports work as `@justfiles/state` and `@justfiles/state/react`.

### Step 2: Implement store core

Implement:

- `createStore`.
- `getState`.
- `dispatch`.
- `subscribe`.

Acceptance tests:

- dispatch updates state.
- no notification if reducer returns the same state.

### Step 3: Implement effect runner

- Run effects after state notification.
- Pass `(action, previous, next, { getState, dispatch })`.
- Allow async effects.
- Always log unhandled effect errors to the console; no configuration knob.

Acceptance tests:

- effect observes previous and next state.
- effect can dispatch follow-up action.
- async effect does not block state notification.
- re-entrant dispatch from inside an effect is queued: the outer effect finishes its sync portion before the queued action's reducer runs.
- the queued action's effects see the post-outer-dispatch state as their `previous`.
- when reducer returns the same state reference, neither subscribers nor effects fire.

### Step 4: Implement React adapter

- Use `useSyncExternalStore`.
- Support selectors.
- Avoid rerender when selected value is equal.

Acceptance:

- small React test or compile-only test proving hook types.

### Step 5: Add Frieren OS model

New files under `platform/frieren/src/os/`:

- `state.ts`: `OsState`, `OsAction`, initial state.
- `reducer.ts`: pure transitions.
- `selectors.ts`: focused window, z-index, ordered windows, `selectVisibleFullscreenId`, `selectChatOpen`.
- `store.ts`: builds effect list (closed over kernel host, socket, fs volume) and creates store.
- `persistence.ts`: load/save snapshot.
- `effects.ts`: kernel host, websocket, persistence effects.

Acceptance:

- reducer unit tests for open, close, focus, rect update, fullscreen/minimize.
- selector test: `selectVisibleFullscreenId` returns the top-of-focusStack window whose mode is `fullscreen`, or `null` if none.
- selector test: closing the visible fullscreen window pops focus; the new visible-fullscreen is the next fullscreen down the stack, or `null` if the new top is floating.

### Step 6: Migrate Frieren shell state

Move from React/useChat into OS store:

- `openApps`.
- `focusStack`.
- `fullscreenKey` / fullscreen mode.
- `chatOpen`.
- window rect state from `Window`/`windowState.ts`.

Keep outside OS store:

- chat messages/input/streaming.
- installed app catalog if it remains websocket-provided server data.
- `kernelAppHost` internal map.
- drag-in-progress state inside `Window` — only the committed rect (on drop/resize-end) flows to OS state via `window.rectUpdated`.

`Window` component contract change: today it takes `persist={ load, save }` per instance. After migration it reads its `rect`/`focused`/`zIndex`/`mode` via OS-state selectors and dispatches actions (`window.rectUpdated`, `window.focused`, etc.) on user gestures. `windowState.ts` and per-app `/applications/:appId/window.json` go away.

Acceptance:

- launching, focusing, closing apps still works.
- window movement and size persists in `/system/os-state.json`.
- reload resumes shell layout.

### Step 7: Consider `@justfiles/app` reuse

Only after Frieren OS state is stable:

- Move generic `MaybePromise` into `@justfiles/state`.
- Optionally move a tiny mutation/query runner if it reduces duplication.
- Keep `defineApp`'s public interface unchanged.

Acceptance:

- all existing app packages compile unchanged.
- app runtime tests pass unchanged.

### Step 8: Broaden the frieren test runner to all of `src`

The `platform/frieren/src/**` vitest exclude predates any src tests — a blunt
guardrail from the pnpm+vitest migration, not a considered choice. Step 5
carved out `src/os/**` (pure, node-safe logic) as a stopgap. Once component and
hook tests are wanted, replace the carve-out with full coverage:

- Drop the `platform/frieren/src/!(os)/**` exclude and the `src/os/**` include; add
  a single `platform/frieren/src/**/*.test.{ts,tsx}` include.
- Give those tests a DOM: add `jsdom` (or `happy-dom`) and set
  `test.environment` so React component/hook tests can render.
- Resolve the `@/` path alias in the vitest config so `@/…` imports match the
  app's tsconfig.

Acceptance:

- `pnpm test` runs every `*.test.ts(x)` under `platform/frieren/src`, including at
  least one React-rendering test, with no env-resolution errors.

Note: `tsc -b` already typechecks all of `src` (via `tsconfig.app.json`'s
`include: ["src"]`); this step is about the *test runner*, not typecheck.

## Non-goals

- No devtools protocol.
- No middleware plugin system.
- No Immer dependency.
- No proxy state.
- No schema dependency in `@justfiles/state` core.
- No persistence implementation in core.
- No React dependency in core.
