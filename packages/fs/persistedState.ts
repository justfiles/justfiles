import type { Volume } from './volume'

/**
 * An async-persistent state cell.
 *
 * - Loads from disk lazily on the first get(), then stays in memory.
 * - Every set() / patch() updates the in-memory value before writing.
 * - patch() merges a partial update, so unrelated fields are never lost.
 * - patch() is only callable when T is an object type.
 */
export type PersistedState<T> = {
	get(): Promise<T>
	set(value: T): Promise<void>
	patch: T extends object ? (partial: Partial<T>) => Promise<void> : never
}

/**
 * Create a persisted state cell backed by a file at `path`.
 *
 * `init` is the value (or a factory function) used on first access when no
 * file exists yet. Use a function to defer side-effects like UUID generation.
 *
 * Values are stored as JSON, so T must be JSON-serialisable.
 */
export function persistedState<T>(
	vol: Volume,
	path: string,
	init: T | (() => T | Promise<T>)
): PersistedState<T> {
	let _cache: T | undefined
	const enc = new TextEncoder()
	const dec = new TextDecoder()
	const dir = path.split('/').slice(0, -1).join('/') || '/'

	async function get(): Promise<T> {
		if (_cache !== undefined) return _cache
		if (await vol.exists(path)) {
			return (_cache = JSON.parse(dec.decode(await vol.readFile(path))) as T)
		}
		const value = typeof init === 'function' ? await (init as () => T | Promise<T>)() : init
		await set(value)
		return _cache as T
	}

	async function set(value: T): Promise<void> {
		_cache = value
		await vol.mkdir(dir, { recursive: true })
		await vol.writeFile(path, enc.encode(JSON.stringify(value)))
	}

	async function patch(partial: Partial<T>): Promise<void> {
		await set({ ...(await get()), ...partial } as T)
	}

	return { get, set, patch } as PersistedState<T>
}
