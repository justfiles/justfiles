import type { Volume } from '@justfiles/fs'

type AppId = string

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text)
}

function text(data: Uint8Array): string {
	return new TextDecoder().decode(data)
}

// The app state store: each app's authoritative state lives in memory and is
// written through to `/state/<id>.json` on every commit that CHANGES it
// (durability + DO hibernation). The in-memory copy is the source of truth
// between a read and the next commit; the kernel's per-app queue serializes
// those, so the read-modify-write stays atomic despite the async write. `seq` is
// the monotonic committed version, bumped on each commit — push consumers
// order/dedupe by it and `settled` waits on it. Both caches are in-memory only:
// state is rehydrated from fs on boot, and `seq` is recomputed from zero.
export interface StateStore {
	// Authoritative state: the in-memory copy if present, else hydrated from fs
	// once and cached. Every reader shares one committed value with no per-call read.
	current(appId: AppId): Promise<unknown>
	// Commit a new state: update memory, write through to fs when the value
	// actually changed, then return the committed seq (bumped only on a write).
	commit(appId: AppId, next: unknown): Promise<number>
	// The committed version, 0 before the first commit (and after a boot).
	seq(appId: AppId): number
	// Drop the in-memory copy so the next `current` re-hydrates from fs. The owned
	// model assumes the kernel is the SOLE writer of `/state`, so it caches forever;
	// a host whose volume is ALSO written externally (frieren syncs an agent's
	// server-side edit down to `/state/<id>.json` as a REMOTE_SOURCE write) calls
	// this on that write so the next read reflects the file. No fs I/O — pure
	// invalidation; `seq` is left intact.
	invalidate(appId: AppId): void
	// Forget an app's persisted + in-memory state (uninstall). The seq counter is
	// left intact, so a reinstall keeps the version monotonic for push consumers.
	drop(appId: AppId): Promise<void>
}

export function stateStore(fs: Volume): StateStore {
	// `.has()` distinguishes "not loaded" from "loaded, value undefined".
	const states = new Map<AppId, unknown>()
	const seqs = new Map<AppId, number>()
	// The serialization this store believes is ON DISK, so a commit that lands the
	// same value writes nothing: `/state/<id>.json`'s mtime then means "when the
	// state last CHANGED", and a reducer edge that folds to an identical state (a
	// subscription wake, a re-scan) stops manufacturing writes for sync to carry.
	// Invariant: a belief here is only ever recorded together with the in-memory
	// state it came from, and dropped with it — a belief that outlived its value
	// would let a later commit BACK to that value skip its write, stranding disk
	// ahead of memory until a reboot resurrected it.
	const onDisk = new Map<AppId, string>()
	return { current, commit, seq, invalidate, drop }

	// The file's value plus its serialization, or `{}` when there is no file yet.
	async function load(appId: AppId): Promise<{ value?: unknown; encoded?: string }> {
		const statePath = `/state/${appId}.json`
		try {
			if (await fs.exists(statePath)) {
				const value = JSON.parse(text(await fs.readFile(statePath)))
				return { value, encoded: JSON.stringify(value) }
			}
		} catch {
			return {}
		}
		return {}
	}

	async function current(appId: AppId): Promise<unknown> {
		if (states.has(appId)) return states.get(appId)
		const loaded = await load(appId)
		// A concurrent commit may have populated the cache while we read fs — `state()`
		// and the subscription warm-up both read OFF the per-app queue. Keep the newer
		// authoritative value rather than clobbering it with the load, and take the
		// load's belief about the file only when we took its value too.
		if (!states.has(appId)) {
			states.set(appId, loaded.value)
			if (loaded.encoded !== undefined) onDisk.set(appId, loaded.encoded)
		}
		return states.get(appId)
	}

	async function commit(appId: AppId, next: unknown): Promise<number> {
		// Authoritative in memory, written through to fs for durability.
		states.set(appId, next)
		const encoded = JSON.stringify(next)
		// Same bytes as the file already holds => nothing to persist and nothing new
		// to version, so the committed seq stands.
		if (onDisk.get(appId) === encoded) return seqs.get(appId) ?? 0
		await fs.mkdir('/state', { recursive: true })
		await fs.writeFile(`/state/${appId}.json`, bytes(encoded))
		onDisk.set(appId, encoded)
		const nextSeq = (seqs.get(appId) ?? 0) + 1
		seqs.set(appId, nextSeq)
		return nextSeq
	}

	function seq(appId: AppId): number {
		return seqs.get(appId) ?? 0
	}

	function invalidate(appId: AppId): void {
		states.delete(appId)
		onDisk.delete(appId)
	}

	async function drop(appId: AppId): Promise<void> {
		await fs.rm(`/state/${appId}.json`, { force: true })
		states.delete(appId)
		onDisk.delete(appId)
	}
}
