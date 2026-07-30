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
		// exists() can observe a native-style backend's create-then-fill gap mid-flight
		// (the dirent published, putBlob not landed yet) just as easily as losing the
		// claim below does — same torn window, different entry point. readSettled()
		// covers both: it is NOT "a loser reads back the winner", it is "read this path
		// tolerantly, because someone else may still be mid-write".
		if (await vol.exists(path)) {
			_cache = await readSettled()
			return _cache
		}
		const value = typeof init === 'function' ? await (init as () => T | Promise<T>)() : init
		_cache = await claim(value)
		return _cache
	}

	// The ONLY retryable read failure -- see readSettled below. A native-style
	// create-then-fill gap is always fully empty, never partial (putBlob's
	// handle.writeFile writes the whole buffer, and the preceding truncate(0) is
	// the only other state a concurrent reader can observe) -- so "empty" is a
	// precise, not a heuristic, signature for "still mid-write", and anything else
	// read() throws (EISDIR, a deleted file, real corruption) is permanent.
	class EmptyRead extends Error {}

	async function read(): Promise<T> {
		const raw = dec.decode(await vol.readFile(path))
		if (raw === '') throw new EmptyRead(`empty read: ${path}`)
		return JSON.parse(raw) as T
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
			return readSettled() // lost the claim — read back whichever cell won it
		}
	}

	// Write-then-publish (#321/#322) makes this a NO-OP retry on every backend with
	// a hash-addressed content store (mem/idb/sqlite today): the winner's content is
	// durable before its name is, so the first read below always succeeds — verified
	// empirically (0 of 300 trials needed a second attempt). The loop earns its keep
	// only for a backend WITHOUT that store (nativeStorage today), which still
	// commits createNode THEN putBlob — there, a concurrent reader (whether it just
	// lost the claim above, or merely found the path via exists() in get()) can
	// briefly see it exist with no bytes yet, and this polls for the writer to land.
	// Kept general (not backend-conditional) because `Volume` doesn't expose which
	// backend it's over, and shouldn't — that would leak a storage detail through the
	// one abstraction that's supposed to hide it.
	//
	// Bounded by ELAPSED TIME, not attempt count: 50 zero-delay turns measured ~55ms
	// on a plain dev machine (Node's setTimeout floor, not disk speed), so a fixed
	// count is really a proxy for wall-clock time that a slower or busier filesystem
	// can blow through for a write that is still going to land. A deadline says what
	// is actually meant: give the winner a genuinely generous window, not a lucky
	// number of ticks.
	const READ_SETTLED_DEADLINE_MS = 2000
	async function readSettled(): Promise<T> {
		const deadline = Date.now() + READ_SETTLED_DEADLINE_MS
		for (;;) {
			try {
				return await read()
			} catch (e) {
				if (!(e instanceof EmptyRead) || Date.now() >= deadline) throw e
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
