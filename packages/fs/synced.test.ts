/**
 * The lifecycle wrapper: a volume that runs its own sync.
 *
 * `storeVolume` answers calls and `sync` returns when its cycle is done —
 * neither of them RUNS anything. What is on trial here is the small amount of
 * behaviour that turns the pair into a live replica:
 *
 * - the loop: a timer, a debounced push behind local writes, and the four
 *   controls an app drives it with (`flush`, `pause`, `resume`, `destroy`),
 * - the status an app shows, and the transitions it can watch,
 * - the two resets, which are the only things here that rewrite a whole store:
 *   `takeTheirs` throws this replica's work away, `takeMine` publishes it,
 * - lazy content, which is two things together — a pull that takes rows only,
 *   and a volume that fetches the bytes a read asks for.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { type CursorSlot, versions } from './engine'
import { type Cursor, type Node, ROOT, type Store } from './store'
import { memStore } from './store.mem'
import { type SyncedProps, type SyncStatus, syncedVolume } from './synced'
import { FileType } from './types'
import type { Volume } from './volume'
import { storeVolume } from './volume.store'

const enc = new TextEncoder()
const dec = new TextDecoder()

/** The host-local cursor slot (T8). A variable is the whole contract. */
function slot(): CursorSlot {
	let at: Cursor | undefined
	return {
		load: async () => at,
		save: async (cursor) => {
			at = cursor
		}
	}
}

const stopping: (() => void)[] = []

afterEach(() => {
	for (const stop of stopping.splice(0)) stop()
	vi.useRealTimers()
})

/** One replica against `remote`, with its loop under this test's control. */
async function replica(
	remote: Store,
	over: Partial<SyncedProps> = {}
): Promise<{ vol: Awaited<ReturnType<typeof syncedVolume>>; local: Store }> {
	const local = over.local ?? memStore()
	const vol = await syncedVolume({
		local,
		remote,
		replica: 'a',
		pull: slot(),
		push: slot(),
		interval: 99_999,
		...over
	})
	stopping.push(() => vol.destroy())
	return { vol, local }
}

/**
 * Resolve when the cycle in flight has finished, however it finished. A cycle
 * is a chain of awaits with no timer in it, so advancing the clock STARTS one
 * and says nothing about it being over — this is what says that.
 */
function settled(vol: {
	onStatusChange(fn: (s: SyncStatus) => void): () => void
}): Promise<SyncStatus> {
	return new Promise((resolve) => {
		const off = vol.onStatusChange((status) => {
			if (status === 'syncing') return
			off()
			resolve(status)
		})
	})
}

/** How many cycles the loop has started since this call. */
function cycles(vol: { onStatusChange(fn: (s: SyncStatus) => void): () => void }): () => number {
	let n = 0
	vol.onStatusChange((status) => {
		if (status === 'syncing') n++
	})
	return () => n
}

/** A plain view over a peer's store, for saying what it holds. */
const peerVolume = (store: Store): Volume => storeVolume(store, { mintVersion: versions('b') })

/** Every path a volume holds and what is in it — directories as `<dir>`. */
async function tree(vol: Volume): Promise<Record<string, string>> {
	const out: Record<string, string> = {}
	await vol.scan('/', async (path, stat) => {
		if (path === '/') return
		out[path] = stat.type === FileType.Directory ? '<dir>' : dec.decode(await vol.readFile(path))
	})
	return out
}

/** Who authored the live rows a store holds — the push filter's own question. */
async function authors(store: Store): Promise<string[]> {
	const seen = new Set<string>()
	let cursor: Cursor | undefined
	for (;;) {
		const page = await store.since(cursor)
		for (const row of page.nodes) {
			if (row.deleted || row.id === ROOT) continue
			seen.add(row.version.slice(0, row.version.lastIndexOf(':')))
		}
		if (page.next === undefined) break
		cursor = page.next
		if (page.nodes.length === 0) break
	}
	return [...seen].sort()
}

/**
 * A peer whose store can be replaced behind the handle, which is what a reset
 * authority IS: the same endpoint, no rows, and a lineage whose cursors nothing
 * that outlived it can name (rule 11).
 */
function authorityPeer(): { store: Store; reset: () => Promise<number> } {
	let at = memStore()
	let epoch = 1
	return {
		store: {
			get: (id) => at.get(id),
			child: (parent, name) => at.child(parent, name),
			children: (parent, cursor) => at.children(parent, cursor),
			since: (cursor) => at.since(cursor),
			commit: (writes, guards) => at.commit(writes, guards),
			blobs: {
				has: (hash) => at.blobs.has(hash),
				get: (hash) => at.blobs.get(hash),
				put: (hash, data) => at.blobs.put(hash, data)
			}
		},
		reset: async () => {
			at = memStore()
			return ++epoch
		}
	}
}

describe('syncedVolume: the loop', () => {
	it('hands over a volume that already holds the peer’s tree', async () => {
		const remote = memStore()
		await peerVolume(remote).writeFile('/hello.txt', enc.encode('hi'))

		const { vol } = await replica(remote)

		expect(dec.decode(await vol.readFile('/hello.txt'))).toBe('hi')
		expect(vol.status()).toBe('synced')
	})

	it('is connecting until its first cycle when the caller wanted the volume first', async () => {
		vi.useFakeTimers()
		const remote = memStore()
		await peerVolume(remote).writeFile('/hello.txt', enc.encode('hi'))

		const { vol } = await replica(remote, { localFirst: true })
		const seen: SyncStatus[] = []
		vol.onStatusChange((status) => seen.push(status))
		const done = settled(vol)

		// The local store IS the working copy, so the volume is answering calls
		// before the first cycle has run — which is the whole of `localFirst`.
		expect(vol.status()).toBe('connecting')
		expect(await vol.exists('/hello.txt')).toBe(false)

		await vi.advanceTimersByTimeAsync(0)
		await done

		expect(seen).toEqual(['syncing', 'synced'])
		expect(dec.decode(await vol.readFile('/hello.txt'))).toBe('hi')
	})

	it('runs one push and one pull on flush', async () => {
		const remote = memStore()
		const there = peerVolume(remote)
		const { vol } = await replica(remote)
		await vol.writeFile('/mine.txt', enc.encode('mine'))
		await there.writeFile('/theirs.txt', enc.encode('theirs'))

		await vol.flush()

		expect(dec.decode(await there.readFile('/mine.txt'))).toBe('mine')
		expect(dec.decode(await vol.readFile('/theirs.txt'))).toBe('theirs')
	})

	it('reports the peer being down, and recovers on the next cycle', async () => {
		vi.useFakeTimers()
		const remote = memStore()
		let down = true
		const flaky: Store = {
			...remote,
			since: (cursor) => (down ? Promise.reject(new Error('offline')) : remote.since(cursor))
		}
		await peerVolume(remote).writeFile('/hello.txt', enc.encode('hi'))

		const { vol } = await replica(flaky, { localFirst: true })
		// The engine's own retries and backoff run first; the status turns only
		// when the failure has become this wrapper's.
		const done = settled(vol)
		await vi.advanceTimersByTimeAsync(8_000)

		expect(await done).toBe('error')
		expect(vol.status()).toBe('error')

		down = false
		await vol.flush()

		expect(vol.status()).toBe('synced')
		expect(dec.decode(await vol.readFile('/hello.txt'))).toBe('hi')
	})

	it('stops the loop on pause and starts it again on resume', async () => {
		vi.useFakeTimers()
		const remote = memStore()
		const there = peerVolume(remote)
		const { vol } = await replica(remote)

		vol.pause()
		await vol.writeFile('/paused.txt', enc.encode('x'))
		await vi.advanceTimersByTimeAsync(200_000)

		expect(await there.exists('/paused.txt')).toBe(false)

		const done = settled(vol)
		vol.resume()
		await done

		expect(await there.exists('/paused.txt')).toBe(true)
	})

	it('runs nothing at all after destroy', async () => {
		vi.useFakeTimers()
		const remote = memStore()
		const there = peerVolume(remote)
		const { vol } = await replica(remote)

		vol.destroy()
		await vol.writeFile('/after.txt', enc.encode('x'))
		await vi.advanceTimersByTimeAsync(200_000)

		expect(await there.exists('/after.txt')).toBe(false)

		// Not even when asked outright: a destroyed replica is done, and a caller
		// that flushes on the way out (frieren does, on `pagehide`) must not
		// resurrect the loop.
		await vol.flush()

		expect(await there.exists('/after.txt')).toBe(false)
	})
})

describe('syncedVolume: the debounced push', () => {
	it('folds a burst into one cycle, three seconds after the last write', async () => {
		vi.useFakeTimers()
		const remote = memStore()
		const there = peerVolume(remote)
		const { vol } = await replica(remote)
		const ran = cycles(vol)
		const done = settled(vol)

		await vol.writeFile('/a.txt', enc.encode('a'))
		await vi.advanceTimersByTimeAsync(2_000)
		await vol.writeFile('/b.txt', enc.encode('b'))
		await vi.advanceTimersByTimeAsync(2_999)

		expect(ran()).toBe(0)

		await vi.advanceTimersByTimeAsync(1)
		await done

		expect(ran()).toBe(1)
		expect(await there.exists('/a.txt')).toBe(true)
		expect(await there.exists('/b.txt')).toBe(true)
	})

	it('pushes after fifteen seconds of writes that never stop', async () => {
		vi.useFakeTimers()
		const { vol } = await replica(memStore())
		const ran = cycles(vol)

		await vol.writeFile('/state.json', enc.encode('0'))
		for (let n = 1; n <= 7; n++) {
			await vi.advanceTimersByTimeAsync(2_000)
			await vol.writeFile('/state.json', enc.encode(String(n)))
		}
		await vi.advanceTimersByTimeAsync(999)

		expect(ran()).toBe(0)

		await vi.advanceTimersByTimeAsync(1)

		expect(ran()).toBe(1)
	})

	it('stays quiet when a cycle only applied the peer’s rows', async () => {
		vi.useFakeTimers()
		const remote = memStore()
		const there = peerVolume(remote)
		const { vol } = await replica(remote)
		const ran = cycles(vol)
		await there.writeFile('/theirs.txt', enc.encode('x'))

		await vol.flush()

		expect(ran()).toBe(1)
		expect(await vol.exists('/theirs.txt')).toBe(true)

		// A pulled row is authored by the peer. Arming a push for it would spend a
		// cycle offering that peer its own rows back, for ever.
		await vi.advanceTimersByTimeAsync(3_000)

		expect(ran()).toBe(1)
	})
})

/** A bare file row, for a write that has to reach the store directly. */
const row = (id: string, name: string, version: string): Node => ({
	id,
	parent: ROOT,
	name,
	type: 'file',
	mode: 0o100644,
	mtimeNs: 0n,
	size: 0n,
	version
})

/**
 * A store that lets one write land immediately after the next commit: the app
 * writing between a reset's passes, which stopping the loop does not prevent.
 */
function racing(store: Store): Store & { armWith: (rows: Node[]) => void } {
	let pending: Node[] | null = null
	return {
		...store,
		armWith(rows) {
			pending = rows
		},
		async commit(writes, guards) {
			await store.commit(writes, guards)
			const landing = pending
			pending = null
			if (landing) await store.commit(landing)
		}
	}
}

describe('syncedVolume: take theirs', () => {
	it('throws this replica’s work away and takes the peer’s tree', async () => {
		const remote = memStore()
		const there = peerVolume(remote)
		await there.writeFile('/keep.txt', enc.encode('theirs'))
		const { vol } = await replica(remote)
		// Divergence, none of it pushed: an edit to a shared file, and a file the
		// peer has never heard of.
		await vol.writeFile('/keep.txt', enc.encode('mine'))
		await vol.writeFile('/only-here.txt', enc.encode('mine'))

		await vol.takeTheirs()

		expect(await tree(vol)).toEqual({ '/keep.txt': 'theirs' })
		// And the peer never hears about any of it. The discarded rows are this
		// replica's own, so an ordinary push would carry them — taking the volume
		// down with them on every other replica.
		expect(await tree(there)).toEqual({ '/keep.txt': 'theirs' })
	})

	// Stopping the loop does not stop the app, so a row can land between the
	// tombstones and the cutoff. One that escaped would be alive here and PAST
	// the cursor that decides what is ever offered — device-only for good.
	it('catches a write that lands while it is discarding', async () => {
		const remote = memStore()
		const there = peerVolume(remote)
		await there.writeFile('/keep.txt', enc.encode('theirs'))
		const local = racing(memStore())
		const { vol } = await replica(remote, { local })
		await vol.writeFile('/mine.txt', enc.encode('mine'))
		local.armWith([row('stray', 'stray.txt', 'a:stray-1')])

		await vol.takeTheirs()

		expect(await tree(vol)).toEqual({ '/keep.txt': 'theirs' })

		await vol.flush()

		expect(await tree(there)).toEqual({ '/keep.txt': 'theirs' })
	})

	it('refuses while the loop is stopped, before anything is discarded', async () => {
		const remote = memStore()
		const there = peerVolume(remote)
		await there.writeFile('/keep.txt', enc.encode('theirs'))
		const { vol } = await replica(remote)
		await vol.writeFile('/mine.txt', enc.encode('mine'))

		// A reset is destroy-then-converge, and a stopped loop cannot run the
		// second half: it would resolve reporting success over an emptied volume.
		vol.pause()

		await expect(vol.takeTheirs()).rejects.toThrow(/running sync loop/)
		expect(await tree(vol)).toEqual({ '/keep.txt': 'theirs', '/mine.txt': 'mine' })
	})

	// Waiting for the cycle in flight is a window the app can act in — frieren
	// tears a profile down on user switch — and a reset that went ahead anyway
	// would tombstone the tree with no loop left to converge it.
	it('refuses when the loop is stopped while it waits for the cycle in flight', async () => {
		const remote = memStore()
		const there = peerVolume(remote)
		await there.writeFile('/keep.txt', enc.encode('theirs'))
		let release = (): void => {}
		const parked = new Promise<void>((resolve) => {
			release = resolve
		})
		let hold = false
		const slow: Store = {
			...remote,
			since: async (cursor) => {
				if (hold) await parked
				return remote.since(cursor)
			}
		}
		const { vol } = await replica(slow)
		await vol.writeFile('/mine.txt', enc.encode('mine'))

		hold = true
		const cycle = vol.flush()
		const reset = vol.takeTheirs()
		vol.destroy()
		release()
		await cycle

		await expect(reset).rejects.toThrow(/running sync loop/)
		expect(await tree(vol)).toEqual({ '/keep.txt': 'theirs', '/mine.txt': 'mine' })
	})

	// Only a writer that reaches the store directly can do this: the volume
	// resolves paths, a tombstoned row has none, and every volume write that
	// reuses an id guards on the version it read. But rule 9 puts "a tombstone is
	// final" at the AUTHORITY, so a replica's own store will take one back — and a
	// row that returned after its pass would sit past the cutoff.
	it('catches a row that comes back after its tombstone', async () => {
		const remote = memStore()
		const there = peerVolume(remote)
		await there.writeFile('/keep.txt', enc.encode('theirs'))
		const local = racing(memStore())
		const { vol } = await replica(remote, { local })
		await vol.writeFile('/mine.txt', enc.encode('mine'))
		const row = await local.child(ROOT, 'mine.txt')
		if (!row) throw new Error('the row this test is about is not there')
		local.armWith([{ ...row, size: 99n, version: 'a:revived-1' }])

		await vol.takeTheirs()

		expect(await tree(vol)).toEqual({ '/keep.txt': 'theirs' })

		await vol.flush()

		expect(await tree(there)).toEqual({ '/keep.txt': 'theirs' })
	})

	// The one state this loop must never run in: the tombstones are here and the
	// cursor that keeps them local is not, so one push would carry them to the
	// authority and every other replica would lose the volume.
	it('stops syncing when it cannot record the cutoff, and recovers on a retry', async () => {
		vi.useFakeTimers()
		const remote = memStore()
		const there = peerVolume(remote)
		await there.writeFile('/keep.txt', enc.encode('theirs'))
		let broken = false
		const push = slot()
		const flaky: CursorSlot = {
			load: () => push.load(),
			save: (cursor) => (broken ? Promise.reject(new Error('the slot is full')) : push.save(cursor))
		}
		const { vol } = await replica(remote, { push: flaky })
		await vol.writeFile('/mine.txt', enc.encode('mine'))

		broken = true
		await expect(vol.takeTheirs()).rejects.toThrow('the slot is full')

		await vi.advanceTimersByTimeAsync(200_000)
		await vol.flush()

		expect(await tree(there)).toEqual({ '/keep.txt': 'theirs' })

		// And it is not a dead end: the retry finds nothing left to tombstone and
		// saves the cutoff the first run could not.
		broken = false
		await vol.takeTheirs()

		expect(await tree(vol)).toEqual({ '/keep.txt': 'theirs' })
		expect(await tree(there)).toEqual({ '/keep.txt': 'theirs' })
	})

	it('leaves a replica that keeps syncing afterwards', async () => {
		const remote = memStore()
		const there = peerVolume(remote)
		await there.writeFile('/keep.txt', enc.encode('theirs'))
		const { vol } = await replica(remote)
		await vol.takeTheirs()

		await vol.writeFile('/after.txt', enc.encode('after'))
		await vol.flush()
		await there.writeFile('/later.txt', enc.encode('later'))
		await vol.flush()

		expect(await tree(vol)).toEqual({
			'/keep.txt': 'theirs',
			'/after.txt': 'after',
			'/later.txt': 'later'
		})
		expect(await tree(there)).toEqual(await tree(vol))
	})
})

describe('syncedVolume: take mine', () => {
	it('publishes this volume to a reset authority, and the other replica converges', async () => {
		const hub = authorityPeer()
		const a = await replica(hub.store, { replica: 'a', reset: hub.reset })
		const b = await replica(hub.store, { replica: 'b' })
		await a.vol.writeFile('/a.txt', enc.encode('from a'))
		await a.vol.flush()
		await b.vol.flush()
		await b.vol.writeFile('/b.txt', enc.encode('from b'))
		await b.vol.flush()
		await a.vol.flush()

		expect(await tree(a.vol)).toEqual({ '/a.txt': 'from a', '/b.txt': 'from b' })
		expect(a.vol.generation()).toBeUndefined()

		await a.vol.takeMine()

		// The whole volume is on the fresh authority — including the row this
		// replica merely HELD. A replica pushes what it authored, so re-authoring
		// is what makes the rest of the tree its to publish.
		expect(await tree(storeVolume(hub.store))).toEqual({
			'/a.txt': 'from a',
			'/b.txt': 'from b'
		})
		expect(await authors(hub.store)).toEqual(['a'])
		expect(a.vol.generation()).toBe(2)

		await b.vol.flush()

		expect(await tree(b.vol)).toEqual({ '/a.txt': 'from a', '/b.txt': 'from b' })
	})

	// The mirror of the discard's late arrival: a row this replica did NOT author,
	// landing after the pass that would have re-authored it, is filtered out of
	// every push from here on — visible locally, absent from the authority.
	it('publishes a foreign row that lands while it is re-authoring', async () => {
		const hub = authorityPeer()
		const local = racing(memStore())
		const { vol } = await replica(hub.store, { local, reset: hub.reset })
		await vol.writeFile('/a.txt', enc.encode('from a'))
		await vol.flush()
		// A row this replica holds but did not write, as a pull would leave it: it
		// is what the first pass re-authors, and so what the second one races.
		await local.commit([row('first', 'first.txt', 'b:first-1')])
		local.armWith([row('theirs', 'theirs.txt', 'b:landed-1')])

		await vol.takeMine()

		expect(await tree(storeVolume(hub.store))).toEqual({
			'/a.txt': 'from a',
			'/first.txt': '',
			'/theirs.txt': ''
		})
		expect(await authors(hub.store)).toEqual(['a'])
	})

	// What makes the crash story cost nothing: interrupted anywhere, running it
	// again is both the retry and the recovery, so there is no durable
	// "publishing" marker to keep and nothing to resume.
	it('publishes the same volume again when it is run a second time', async () => {
		const hub = authorityPeer()
		const a = await replica(hub.store, { reset: hub.reset })
		await a.vol.writeFile('/a.txt', enc.encode('from a'))
		await a.vol.flush()

		await a.vol.takeMine()
		await a.vol.takeMine()

		expect(await tree(storeVolume(hub.store))).toEqual({ '/a.txt': 'from a' })
		expect(a.vol.generation()).toBe(3)
	})

	it('refuses while the loop is stopped, before the authority is truncated', async () => {
		const hub = authorityPeer()
		let reset = 0
		const { vol } = await replica(hub.store, {
			reset: () => {
				reset++
				return hub.reset()
			}
		})
		vol.pause()

		await expect(vol.takeMine()).rejects.toThrow(/running sync loop/)
		expect(reset).toBe(0)
	})

	it('refuses when the peer has no way to start a new lineage', async () => {
		const { vol } = await replica(memStore())
		await expect(vol.takeMine()).rejects.toThrow(/lineage/)
	})

	// Both destructive bodies over one store would interleave their passes and
	// their flags, and the app offers them from a menu with no in-flight gate
	// (`apps/frieren/src/shell/DesktopShell.tsx`).
	it('refuses a second reset while one is running', async () => {
		const hub = authorityPeer()
		const { vol } = await replica(hub.store, { reset: hub.reset })
		await vol.writeFile('/a.txt', enc.encode('from a'))
		await vol.flush()

		const first = vol.takeMine()

		await expect(vol.takeTheirs()).rejects.toThrow(/already running/)
		await first

		expect(await tree(storeVolume(hub.store))).toEqual({ '/a.txt': 'from a' })
	})

	// A reset that says "done" is the app's cue to move on — frieren's menu
	// alerts on a rejection and otherwise says nothing — so the cycle that makes
	// the reset real is the one cycle whose failure belongs to the caller.
	it('reports a final cycle the peer would not take', async () => {
		vi.useFakeTimers()
		const hub = authorityPeer()
		let down = false
		const peer: Store = {
			...hub.store,
			since: (cursor) => (down ? Promise.reject(new Error('offline')) : hub.store.since(cursor))
		}
		const { vol } = await replica(peer, {
			reset: async () => {
				down = true // the authority is truncated, and now unreachable
				return hub.reset()
			}
		})
		await vol.writeFile('/a.txt', enc.encode('from a'))
		await vol.flush()

		const done = vol.takeMine().catch((e: unknown) => e)
		await vi.advanceTimersByTimeAsync(8_000)

		expect(await done).toMatchObject({ message: expect.stringContaining('did not converge') })
	})

	// Nothing here can hold a teardown off — the app tears the STORE down behind
	// this wrapper — so a reset the loop was stopped under must at least say it
	// did not converge, rather than resolving as though it had.
	it('reports a reset the loop was torn down under', async () => {
		const hub = authorityPeer()
		let torn: (() => void) | undefined
		const { vol } = await replica(hub.store, {
			reset: async () => {
				torn?.()
				return hub.reset()
			}
		})
		torn = () => vol.destroy()
		await vol.writeFile('/a.txt', enc.encode('from a'))
		await vol.flush()

		await expect(vol.takeMine()).rejects.toThrow(/did not converge/)
	})

	// A reset stops the loop while it rewrites the store. One that fails has to
	// start it again on its way out, or a volume the user only tried to publish
	// stops syncing at all — and nothing would say so.
	it('leaves the loop running when the reset fails', async () => {
		vi.useFakeTimers()
		const { vol } = await replica(memStore(), {
			reset: () => Promise.reject(new Error('the authority said no'))
		})
		const ran = cycles(vol)

		await expect(vol.takeMine()).rejects.toThrow('the authority said no')
		await vi.advanceTimersByTimeAsync(99_999)

		expect(ran()).toBe(1)
	})
})

describe('syncedVolume: lazy content', () => {
	it('reads a file the pull never brought the bytes for', async () => {
		const remote = memStore()
		await peerVolume(remote).writeFile('/doc.txt', enc.encode('the bytes'))

		const { vol, local } = await replica(remote, { lazyContent: true })
		const { contentHash } = await vol.stat('/doc.txt')

		expect(contentHash).toBeDefined()
		expect(await local.blobs.has(contentHash ?? '')).toBe(false)
		expect(dec.decode(await vol.readFile('/doc.txt'))).toBe('the bytes')
		// And it keeps what it fetched: the stub is hydrated, not re-fetched on
		// every read.
		expect(await local.blobs.has(contentHash ?? '')).toBe(true)
	})

	it('brings the bytes behind the rows when it is not lazy', async () => {
		const remote = memStore()
		await peerVolume(remote).writeFile('/doc.txt', enc.encode('the bytes'))

		const { vol, local } = await replica(remote)
		const { contentHash } = await vol.stat('/doc.txt')

		expect(await local.blobs.has(contentHash ?? '')).toBe(true)
	})
})

describe('syncedVolume: the surface', () => {
	// Read out of `apps/frieren/src/fs.ts`: every member the app calls on what
	// `synced()` hands it. Listed here so a drift fails loudly now rather than at
	// the swap. `apps/worker/src/react-app/useVolume.ts` is the other consumer and
	// asks for nothing beyond `Volume`.
	const CONSUMED = [
		'readFile',
		'flush',
		'pause',
		'resume',
		'destroy',
		'status',
		'onStatusChange',
		'takeTheirs',
		'takeMine',
		'generation'
	] as const

	it('has every member the app consumes', async () => {
		const { vol } = await replica(memStore())

		for (const member of CONSUMED) expect(typeof vol[member]).toBe('function')
	})
})
