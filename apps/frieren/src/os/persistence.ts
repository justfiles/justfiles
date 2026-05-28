import type { Volume } from '../fs'
import { initialState, type OsState } from './state'

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
		Array.isArray(s.focusStack) &&
		typeof s.chatOpen === 'boolean'
	)
}

// Read the persisted snapshot. Any failure falls back to a fresh state rather
// than bricking the shell on a corrupt file.
export async function loadSnapshot(volume: Volume): Promise<OsState> {
	try {
		if (!(await volume.exists(PATH))) return initialState
		const data = JSON.parse(new TextDecoder().decode(await volume.readFile(PATH)))
		if (isOsState(data)) return data
	} catch {
		// corrupt or unreadable snapshot — fall through to a fresh state
	}
	return initialState
}

export async function saveSnapshot(volume: Volume, serialized: string): Promise<void> {
	await volume.mkdir('/system', { recursive: true })
	await volume.writeFile(PATH, new TextEncoder().encode(serialized))
}
