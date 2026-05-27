# `@justfiles/state` design

## Goal

Create a small framework-neutral state package that can back both:

- kernel apps: durable semantic app state, action handlers, queries, capability-backed async work.
- Frieren OS shell: durable window/session state, selectors, persistence, and browser-side effects.

Keep the package minimal. It should not become a Redux/Zustand clone.

## What the existing apps teach us

Existing `@justfiles/app` apps already follow a strong state discipline:

- App state is durable and semantic.
	- Finder persists `currentViewing`, `files`, `loading`, `error`.
	- Paint persists `tool`, `size`, `color`, save status.
	- Crossword persists puzzle/play state.
- Transient UI state stays outside reducer state.
	- Finder preview text is GUI-local because file bytes can change.
	- Paint canvas pixels, drag state, undo/redo, and `busy` are GUI-local.
	- Crossword input draft and temporary call errors are GUI-local.
- Actions can be async.
	- Finder `refresh` scans volume.
	- Paint `save` writes PNG bytes.
	- Settings talks to integrations.
	- Crossword calls AI.
- Queries read without persisting.
	- Finder `readFile` returns preview bytes but does not store them.
- Current app dispatch is atomic from the GUI's point of view.
	- A handler receives current state, awaits capabilities, returns the next state, then the kernel persists and broadcasts it.

The OS shell has the same durable-state need, but adds two requirements the app runtime does not currently have:

- selector subscriptions, so moving/focusing one window does not rerender unrelated windows.
- local effects, because opening/closing/focusing windows must also talk to `kernelAppHost`, websocket, and persistence.

## Core terms

- **State**: JSON-serializable durable data.
- **Action**: serializable event/command input.
- **Mutation**: action handler that returns next state.
- **Query**: action handler that returns a value and does not persist state.
- **Effect**: non-serializable work triggered around a state transition: filesystem writes, websocket sends, DOM/kernel host calls.
- **Selector**: function from state to a smaller value for subscriptions/rendering.

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
	replaceState(state: State): void
	subscribe(listener: () => void): Unsubscribe
	subscribeSelector<T>(
		selector: (state: State) => T,
		listener: (value: T, previous: T) => void,
		equal?: (a: T, b: T) => boolean
	): Unsubscribe
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

## Store model

The OS shell should use a pure reducer plus effects:

```ts
export type Reducer<State, Action> = (state: State, action: Action) => State

export type EffectContext<State, Action, Env> = {
	getState(): State
	dispatch(action: Action): void
	env: Env
}

export type Effect<State, Action, Env> = (
	action: Action,
	previous: State,
	next: State,
	ctx: EffectContext<State, Action, Env>
) => MaybePromise<void>

export function createStore<State, Action, Env = never>(options: {
	initialState: State
	reducer: Reducer<State, Action>
	effects?: readonly Effect<State, Action, Env>[]
	env?: Env
}): Store<State, Action>
```

Rules:

- `reducer` is pure and synchronous.
- `dispatch` updates state and notifies subscribers synchronously.
- effects run after notification.
- effects may dispatch follow-up actions.
- effect failures do not roll back state; they should dispatch explicit failure actions when needed.

This gives the OS a clean split:

- reducer owns durable facts: windows, rects, focus stack, fullscreen, open panels.
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

const openEffect: Effect<OsState, OsAction, OsEnv> = async (action, _prev, _next, ctx) => {
	if (action.type !== 'app.open') return
	try {
		ctx.env.kernelAppHost.open(action.appId)
		ctx.env.socket.send(JSON.stringify({ type: 'kernel_app_open', id: action.appId }))
	} catch (error) {
		ctx.dispatch({
			type: 'app.openFailed',
			appId: action.appId,
			message: error instanceof Error ? error.message : String(error)
		})
	}
}
```

For existing kernel apps, keep the current atomic async handler semantics initially. Later, `@justfiles/app` can reuse a small transaction helper from `@justfiles/state` without changing app author code:

```ts
export async function runMutation<State, Params, Env>(input: {
	state: State
	params: Params
	env: Env
	handler: (params: Params, ctx: { state: State; env: Env }) => MaybePromise<State>
}): Promise<State>
```

Do not force all apps to convert to effect-style actions now. OS state and app state have different runtime needs.

## OS state shape

Initial target for Frieren:

```ts
export type WindowRect = { x: number; y: number; w: number; h: number }

export type OsWindow = {
	id: string
	appId: string
	kind: 'app' | 'system'
	title?: string
	rect: WindowRect
	mode: 'floating' | 'fullscreen' | 'minimized'
}

export type OsState = {
	version: 1
	windows: Record<string, OsWindow>
	openOrder: string[]
	focusStack: string[]
	panels: {
		chatOpen: boolean
	}
}
```

Derived selectors:

```ts
selectOpenWindows(state)
selectFocusedWindowId(state)
selectWindow(state, id)
selectWindowZIndex(state, id)
selectChatOpen(state)
```

Do not store:

- DOM nodes.
- websocket objects.
- auth/session objects.
- volume handles.
- React elements.
- `kernelAppHost` stages.
- drag-in-progress refs.

## Persistence

Persistence should be an OS effect, not part of the store core.

- Load once during Frieren boot from `/system/os-state.json`.
- Validate version and shape.
- Reconcile with installed apps from the launcher list.
- Call `store.replaceState(restored)`.
- Debounce writes after state changes.
- Save only `OsState`, not effects/env/actions.

Do not migrate old per-window files at `/applications/:appId/window.json`. The product has not shipped, so backward compatibility is unnecessary. Once OS snapshot persistence lands, stop writing the old files.

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
- `replaceState`.
- `subscribe`.
- `subscribeSelector`.

Acceptance tests:

- dispatch updates state.
- no notification if reducer returns the same state.
- `replaceState` notifies subscribers.
- selector listener only fires when selected value changes.
- custom equality works.

### Step 3: Implement effect runner

- Run effects after state notification.
- Pass `{ action, previous, next, getState, dispatch, env }`.
- Allow async effects.
- Catch/log unhandled effect errors or expose `onEffectError` option.

Acceptance tests:

- effect observes previous and next state.
- effect can dispatch follow-up action.
- async effect does not block state notification.

### Step 4: Implement React adapter

- Use `useSyncExternalStore`.
- Support selectors.
- Avoid rerender when selected value is equal.

Acceptance:

- small React test or compile-only test proving hook types.

### Step 5: Add Frieren OS model

New files under `apps/frieren/src/os/`:

- `state.ts`: `OsState`, `OsAction`, initial state.
- `reducer.ts`: pure transitions.
- `selectors.ts`: focused window, z-index, ordered windows.
- `store.ts`: creates store with effects.
- `persistence.ts`: load/save snapshot.
- `effects.ts`: kernel host, websocket, persistence effects.

Acceptance:

- reducer unit tests for open, close, focus, rect update, fullscreen/minimize.

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

## Non-goals

- No devtools protocol.
- No middleware plugin system.
- No Immer dependency.
- No proxy state.
- No schema dependency in `@justfiles/state` core.
- No persistence implementation in core.
- No React dependency in core.
