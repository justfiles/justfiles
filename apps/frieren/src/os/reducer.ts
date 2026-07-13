import {
	AGENT_WINDOW_ID,
	agentDefaultRect,
	defaultRect,
	type OsAction,
	type OsState,
	type OsWindow,
	type WindowRect
} from './state'

function bringToFront(stack: string[], id: string): string[] {
	if (stack[stack.length - 1] === id) return stack
	return [...stack.filter((x) => x !== id), id]
}

function sameRect(a: WindowRect, b: WindowRect): boolean {
	return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}

function closeWindow(state: OsState, id: string): OsState {
	if (!state.windows[id]) return state
	const { [id]: _removed, ...windows } = state.windows
	return {
		...state,
		windows,
		openOrder: state.openOrder.filter((x) => x !== id),
		focusStack: state.focusStack.filter((x) => x !== id)
	}
}

export function osReducer(state: OsState, action: OsAction): OsState {
	switch (action.type) {
		case 'boot/loaded':
			// `booted` is enforced here, never trusted from disk, so a missing or
			// false value in the snapshot can't strand the shell on its loader.
			return { ...action.state, booted: true }

		case 'app.open': {
			// One window per app is policy, not identity: look the app up by appId.
			// (New windows still use the appId as their id, because that id doubles
			// as the app-host stage key and the server sync key.)
			const existing = Object.values(state.windows).find((w) => w.appId === action.appId)
			if (existing) {
				// Client OS state is authoritative for window state. A remote echo of
				// an open we already have must be a pure no-op — no refocus, no
				// metadata overwrite. Returning the same reference also short-circuits
				// the host/persist effects, so the stage is never re-opened. A direct
				// user re-launch still brings the running window to the front.
				if (action.remote) return state
				const focusStack = bringToFront(state.focusStack, existing.id)
				if (focusStack === state.focusStack) return state
				return { ...state, focusStack }
			}
			const id = action.appId
			const window: OsWindow = {
				id,
				kind: 'app',
				appId: action.appId,
				title: action.title,
				rect: defaultRect(state.openOrder.length),
				mode: 'floating'
			}
			return {
				...state,
				windows: { ...state.windows, [id]: window },
				openOrder: [...state.openOrder, id],
				focusStack: [...state.focusStack, id]
			}
		}

		case 'agent.openWindow': {
			const id = AGENT_WINDOW_ID
			if (state.windows[id]) {
				const focusStack = bringToFront(state.focusStack, id)
				if (focusStack === state.focusStack) return state
				return { ...state, focusStack }
			}
			const window: OsWindow = {
				id,
				kind: 'agent',
				rect: agentDefaultRect(),
				mode: 'floating'
			}
			return {
				...state,
				windows: { ...state.windows, [id]: window },
				openOrder: [...state.openOrder, id],
				focusStack: [...state.focusStack, id]
			}
		}

		case 'window.close':
			return closeWindow(state, action.id)

		case 'window.focus': {
			if (!state.windows[action.id]) return state
			const focusStack = bringToFront(state.focusStack, action.id)
			if (focusStack === state.focusStack) return state
			return { ...state, focusStack }
		}

		case 'window.rectUpdated': {
			const window = state.windows[action.id]
			if (!window || sameRect(window.rect, action.rect)) return state
			return {
				...state,
				windows: { ...state.windows, [action.id]: { ...window, rect: action.rect } }
			}
		}

		case 'window.setMode': {
			const window = state.windows[action.id]
			if (!window || window.mode === action.mode) return state
			return {
				...state,
				windows: { ...state.windows, [action.id]: { ...window, mode: action.mode } }
			}
		}
	}
}
