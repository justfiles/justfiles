import type { Volume } from '../fs'
import { initialState, type OsState, type OsWindow } from './state'

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

// Older snapshots predate `kind`/`appId`: every window was an app window whose
// id was the app id. Normalise them so the rest of the shell can rely on the
// discriminant being present.
function normalizeWindows(state: OsState): OsState {
	const windows: Record<string, OsWindow> = {}
	for (const [id, window] of Object.entries(state.windows))
		windows[id] = window.kind
			? window
			: { ...window, kind: 'app' as const, appId: window.appId ?? id }
	return { ...state, windows }
}

// Read the persisted snapshot. Any failure falls back to a fresh state rather
// than bricking the shell on a corrupt file.
export async function loadSnapshot(volume: Volume): Promise<OsState> {
	try {
		if (!(await volume.exists(PATH))) return initialState
		const data = JSON.parse(new TextDecoder().decode(await volume.readFile(PATH)))
		if (isOsState(data)) return normalizeWindows(data)
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
// that can't be restored on a fresh boot, so they must not persist or sync.
export function serializeOsState(state: OsState): string {
	const persistable = (id: string) => !id.startsWith('.')
	const windows: OsState['windows'] = {}
	for (const [id, window] of Object.entries(state.windows))
		if (persistable(id)) windows[id] = window
	return JSON.stringify({
		...state,
		windows,
		openOrder: state.openOrder.filter(persistable),
		focusStack: state.focusStack.filter(persistable)
	})
}
