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
	booted: boolean
	windows: Record<string, OsWindow>
	openOrder: string[]
	focusStack: string[]
	agentOpen: boolean
}

export type OsAction =
	| { type: 'boot/loaded'; state: OsState }
	// `remote: true` marks an open/close echoed back by the server, so the
	// app-host effect mounts/unmounts the app without re-notifying the
	// server (which would loop, since the server broadcasts to all clients).
	| { type: 'app.open'; appId: string; title?: string; remote?: boolean }
	| { type: 'window.close'; id: string; remote?: boolean }
	| { type: 'window.focus'; id: string }
	| { type: 'window.rectUpdated'; id: string; rect: WindowRect }
	| { type: 'window.setMode'; id: string; mode: WindowMode }
	| { type: 'agent.setOpen'; open: boolean }

export const initialState: OsState = {
	version: 1,
	booted: false,
	windows: {},
	openOrder: [],
	focusStack: [],
	agentOpen: false
}

// Cascade new windows so they don't stack exactly on top of one another.
export function defaultRect(index: number): WindowRect {
	const offset = index * 24
	return { x: 80 + offset, y: 40 + offset, w: 720, h: 520 }
}
