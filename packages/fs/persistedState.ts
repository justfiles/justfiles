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
			_cache = await read()
			return _cache
		}
		const value = typeof init === 'function' ? await (init as () => T | Promise<T>)() : init
		_cache = await claim(value)
		return _cache
	}

	async function read(): Promise<T> {
		return JSON.parse(dec.decode(await vol.readFile(path))) as T
	}

	// First touch must be a CLAIM, not exists()-then-write: a second cell over the
	// SAME underlying storage (a different Volume wrapper — e.g. `synced()` racing an
	// app-level reader/writer of this same path) initializing at the same moment must
	// converge on ONE value, never mint two and silently overwrite one with the other.
	async function claim(value: T): Promise<T> {
		await vol.mkdir(dir, { recursive: true })
		try {
			await vol.writeFile(path, enc.encode(JSON.stringify(value)), { exclusive: true })
			return value
		} catch (e) {
			if (!(e as Error).message.startsWith('EEXIST')) throw e
			return awaitWinner() // lost the claim — read back whichever cell won it
		}
	}

	// The winner's dirent commits (atomicCreate) before its blob content does
	// (`writeFile` is createNode THEN putBlob) — a loser that just lost the claim
	// above can briefly see the path exist with no bytes yet. Poll a few event-loop
	// turns; on every real backend the winner's write lands well inside that window.
	async function awaitWinner(): Promise<T> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await read()
			} catch (e) {
				if (attempt >= 50) throw e
				await new Promise((resolve) => setTimeout(resolve, 0))
			}
		}
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
