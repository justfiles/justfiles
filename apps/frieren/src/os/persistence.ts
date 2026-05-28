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

// Read the persisted snapshot. `serialized` is the exact bytes on disk, used
// to prime the write effect so the `boot/loaded` round-trip writes nothing.
// Any failure falls back to a fresh state rather than bricking the shell.
export async function loadSnapshot(
	volume: Volume
): Promise<{ state: OsState; serialized: string | null }> {
	try {
		if (!(await volume.exists(PATH))) return { state: initialState, serialized: null }
		const serialized = new TextDecoder().decode(await volume.readFile(PATH))
		const data = JSON.parse(serialized)
		if (isOsState(data)) return { state: data, serialized }
	} catch {}
	return { state: initialState, serialized: null }
}

export async function saveSnapshot(volume: Volume, serialized: string): Promise<void> {
	await volume.mkdir('/system', { recursive: true })
	await volume.writeFile(PATH, new TextEncoder().encode(serialized))
}
