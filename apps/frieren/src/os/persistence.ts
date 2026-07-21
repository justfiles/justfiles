import type { Volume } from '../fs'
import { initialState, type OsState, type OsWindow, type WindowRect } from './state'

const PATH = '/system/os-state.json'

function isOsState(data: unknown): data is OsState {
	if (typeof data !== 'object' || data === null) return false
	const s = data as Record<string, unknown>
	return (
		s.version === 1 &&
		typeof s.booted === 'boolean' &&
		typeof s.windows === 'object' &&
		s.windows !== null &&
		Array.isArray(s.openOrder) &&
		Array.isArray(s.focusStack)
	)
}

// Bring older snapshots up to the current shape:
//   - pre-`kind` windows were all app windows whose id was the app id.
//   - geometry used to live on the window as `rect`; it now lives in
//     `placements`. Lift any legacy per-window rect into placements (without
//     clobbering a newer entry) so an upgrade keeps the user's layout, then
//     drop `rect` from the window entries.
function normalize(state: OsState): OsState {
	const placements: Record<string, WindowRect> = { ...(state.placements ?? {}) }
	const windows: Record<string, OsWindow> = {}
	for (const [id, window] of Object.entries(state.windows)) {
		const { rect, ...rest } = window as OsWindow & { rect?: WindowRect }
		if (rect && !placements[id]) placements[id] = rect
		windows[id] = rest.kind ? rest : { ...rest, kind: 'app' as const, appId: rest.appId ?? id }
	}
	return { ...state, windows, placements }
}

// Read the persisted snapshot. Any failure falls back to a fresh state rather
// than bricking the shell on a corrupt file.
export async function loadSnapshot(volume: Volume): Promise<OsState> {
	try {
		if (!(await volume.exists(PATH))) return initialState
		const data = JSON.parse(new TextDecoder().decode(await volume.readFile(PATH)))
		if (isOsState(data)) return normalize(data)
	} catch {
		// corrupt or unreadable snapshot — fall through to a fresh state
	}
	return initialState
}

export async function saveSnapshot(volume: Volume, serialized: string): Promise<void> {
	await volume.mkdir('/system', { recursive: true })
	await volume.writeFile(PATH, new TextEncoder().encode(serialized))
}

// Serialize OS state for persistence, dropping ephemeral windows — ids with a
// leading dot (e.g. devkit's `.preview.<slug>`) back a scoped, off-catalog stage
// that can't be restored on a fresh boot, so they must not persist or sync. The
// same rule applies to their remembered placement.
export function serializeOsState(state: OsState): string {
	const persistable = (id: string) => !id.startsWith('.')
	// Back-compat shim: the snapshot is version 1 and syncs across devices, so a
	// still-cached pre-placements client can load what this build writes. It reads
	// geometry from `window.rect` and accepts version 1, so keep mirroring each
	// open window's placement onto `rect` — new clients read `placements` and
	// ignore it. Drop this when the schema version bumps.
	const windows: Record<string, OsWindow & { rect?: WindowRect }> = {}
	for (const [id, window] of Object.entries(state.windows))
		if (persistable(id)) {
			const rect = state.placements[id]
			windows[id] = rect ? { ...window, rect } : window
		}
	const placements: OsState['placements'] = {}
	for (const [id, rect] of Object.entries(state.placements))
		if (persistable(id)) placements[id] = rect
	return JSON.stringify({
		...state,
		windows,
		openOrder: state.openOrder.filter(persistable),
		focusStack: state.focusStack.filter(persistable),
		placements
	})
}
