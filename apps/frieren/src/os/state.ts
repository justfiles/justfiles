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
	chatOpen: boolean
}

export type OsAction =
	| { type: 'boot/loaded'; state: OsState }
	| { type: 'app.open'; appId: string; title?: string }
	| { type: 'window.close'; id: string }
	| { type: 'window.focus'; id: string }
	| { type: 'window.rectUpdated'; id: string; rect: WindowRect }
	| { type: 'window.setMode'; id: string; mode: WindowMode }
	| { type: 'chat.setOpen'; open: boolean }

export const initialState: OsState = {
	version: 1,
	booted: false,
	windows: {},
	openOrder: [],
	focusStack: [],
	chatOpen: false
}

// Cascade new windows so they don't stack exactly on top of one another.
export function defaultRect(index: number): WindowRect {
	const offset = index * 24
	return { x: 80 + offset, y: 40 + offset, w: 720, h: 520 }
}
