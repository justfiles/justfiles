export type WindowRect = { x: number; y: number; w: number; h: number }

export type WindowMode = 'floating' | 'minimized' | 'fullscreen'

// A window is a view, not necessarily an app: `kind` picks the body the shell
// renders. App windows carry the `appId` they present; the agent window views
// the (kernel-owned) conversation session and has none.
export type OsWindow = {
	id: string
	kind: 'app' | 'agent'
	appId?: string
	title?: string
	rect: WindowRect
	mode: WindowMode
}

// The conversation window is a singleton view of the one current session.
export const AGENT_WINDOW_ID = 'agent'

export type OsState = {
	version: 1
	booted: boolean
	windows: Record<string, OsWindow>
	openOrder: string[]
	focusStack: string[]
}

export type OsAction =
	| { type: 'boot/loaded'; state: OsState }
	// `remote: true` marks an open/close echoed back by the server, so the
	// app-host effect mounts/unmounts the app without re-notifying the
	// server (which would loop, since the server broadcasts to all clients).
	| { type: 'app.open'; appId: string; title?: string; remote?: boolean }
	| { type: 'agent.openWindow' }
	| { type: 'window.close'; id: string; remote?: boolean }
	| { type: 'window.focus'; id: string }
	| { type: 'window.rectUpdated'; id: string; rect: WindowRect }
	| { type: 'window.setMode'; id: string; mode: WindowMode }

export const initialState: OsState = {
	version: 1,
	booted: false,
	windows: {},
	openOrder: [],
	focusStack: []
}

// Cascade new windows so they don't stack exactly on top of one another.
export function defaultRect(index: number): WindowRect {
	const offset = index * 24
	return { x: 80 + offset, y: 40 + offset, w: 720, h: 520 }
}

// The agent window docks to the right edge by default: x is deliberately
// off-screen, and the Window renderer clamps rects to the viewport, so this
// lands flush right on any screen size.
export function agentDefaultRect(): WindowRect {
	return { x: 8000, y: 48, w: 420, h: 620 }
}
