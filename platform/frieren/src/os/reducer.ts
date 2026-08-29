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
				mode: 'floating'
			}
			return {
				...state,
				windows: { ...state.windows, [id]: window },
				openOrder: [...state.openOrder, id],
				focusStack: [...state.focusStack, id],
				// Reuse a remembered placement (relaunch resumes where it was); a
				// first-ever open falls back to the cascade default. Every open window
				// thus has a placement, so the renderer never lacks a rect.
				placements: {
					...state.placements,
					[id]: state.placements[id] ?? defaultRect(state.openOrder.length)
				}
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
				mode: 'floating'
			}
			return {
				...state,
				windows: { ...state.windows, [id]: window },
				openOrder: [...state.openOrder, id],
				focusStack: [...state.focusStack, id],
				placements: { ...state.placements, [id]: state.placements[id] ?? agentDefaultRect() }
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
			// Close deliberately leaves the placement behind, so guard on the window
			// being open — a stray rect update never resurrects geometry for a
			// window that isn't running.
			const current = state.placements[action.id]
			if (!state.windows[action.id] || (current && sameRect(current, action.rect))) return state
			return {
				...state,
				placements: { ...state.placements, [action.id]: action.rect }
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

		case 'assistant.setSize':
			if (
				state.assistant.size.sheet === action.size.sheet &&
				state.assistant.size.sidebar === action.size.sidebar
			)
				return state
			return { ...state, assistant: { ...state.assistant, size: action.size } }

		case 'assistant.setOpen': {
			const open = Boolean(state.assistant.open[action.id])
			if (open === action.open) return state
			if (action.open)
				return {
					...state,
					assistant: {
						...state.assistant,
						open: { ...state.assistant.open, [action.id]: true }
					}
				}
			const { [action.id]: _closed, ...rest } = state.assistant.open
			return { ...state, assistant: { ...state.assistant, open: rest } }
		}
	}
}
