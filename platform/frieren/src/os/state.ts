import type { Category } from '@justfiles/ui/settings/types'
export type WindowRect = { x: number; y: number; w: number; h: number }

export type WindowMode = 'floating' | 'minimized' | 'fullscreen'

export type AttachedAgentState = {
	size: { sheet: number; sidebar: number }
	open: Record<string, true>
}

export const initialAttachedAgentState: AttachedAgentState = {
	size: { sheet: 280, sidebar: 300 },
	open: {}
}

// A window is a view, not necessarily an app: `kind` picks the body the shell
// renders. App windows carry the `appId` they present; the agent window views
// the (kernel-owned) conversation session and has none. Geometry is NOT here —
// it lives in `OsState.placements` (durable memory keyed by window id), so a
// window entry describes only the running session (kind/appId/title/mode).
export type OsWindow = {
	id: string
	kind: 'app' | 'agent' | 'settings'
	category?: Category
	appId?: string
	title?: string
	mode: WindowMode
}

// The conversation window is a singleton view of the one current session.
export const AGENT_WINDOW_ID = 'agent'
export const SETTINGS_WINDOW_ID = 'settings'

export type OsState = {
	version: 1
	booted: boolean
	// The running session: which windows are open, their z-order and focus.
	windows: Record<string, OsWindow>
	openOrder: string[]
	focusStack: string[]
	// Durable geometry memory, keyed by window id (the appId for app windows,
	// AGENT_WINDOW_ID for the agent). Survives close so a relaunched app resumes
	// its last position/size. The single source of truth for a window's rect.
	placements: Record<string, WindowRect>
	assistant: AttachedAgentState
}

export type OsAction =
	| { type: 'boot/loaded'; state: OsState }
	// `remote: true` marks an open/close echoed back by the server, so the
	// app-host effect mounts/unmounts the app without re-notifying the
	// server (which would loop, since the server broadcasts to all clients).
	| { type: 'app.open'; appId: string; title?: string; remote?: boolean }
	| { type: 'agent.openWindow' }
	| { type: 'settings.open'; category?: Category }
	| { type: 'window.close'; id: string; remote?: boolean }
	| { type: 'window.focus'; id: string }
	| { type: 'window.rectUpdated'; id: string; rect: WindowRect }
	| { type: 'window.setMode'; id: string; mode: WindowMode }
	| { type: 'assistant.setSize'; size: AttachedAgentState['size'] }
	| { type: 'assistant.setOpen'; id: string; open: boolean }

export const initialState: OsState = {
	version: 1,
	booted: false,
	windows: {},
	openOrder: [],
	focusStack: [],
	placements: {},
	assistant: initialAttachedAgentState
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
