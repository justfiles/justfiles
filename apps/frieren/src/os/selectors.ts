import type { OsState, OsWindow } from './state'

export function selectBooted(state: OsState): boolean {
	return state.booted
}

export function selectOpenWindows(state: OsState): OsWindow[] {
	return state.openOrder
		.map((id) => state.windows[id])
		.filter((window): window is OsWindow => window !== undefined)
}

export function selectFocusedWindowId(state: OsState): string | null {
	return state.focusStack[state.focusStack.length - 1] ?? null
}

export function selectWindow(state: OsState, id: string): OsWindow | undefined {
	return state.windows[id]
}

export function selectWindowZIndex(state: OsState, id: string): number {
	return state.focusStack.indexOf(id) + 1
}

// Top-down walk of the focus stack, returning the first fullscreen window —
// the one currently covering the desktop. `null` when the top of the stack
// is reached without finding one.
export function selectVisibleFullscreenId(state: OsState): string | null {
	for (let i = state.focusStack.length - 1; i >= 0; i--) {
		const id = state.focusStack[i]
		if (id && state.windows[id]?.mode === 'fullscreen') return id
	}
	return null
}

export function selectAgentOpen(state: OsState): boolean {
	return state.agentOpen
}
