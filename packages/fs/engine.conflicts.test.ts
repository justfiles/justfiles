/**
 * v1 conflict policy: reject and replan. No merges.
 *
 * Two replicas and an authority hub, which is the whole topology the design
 * names for a client–server star. Each case is a real POSIX write on each side,
 * a push the authority refuses, and the state everything settles on. The test
 * names ARE the policy — if a review changes an outcome, only `engine.ts` and
 * this file move, and no `store.ts` type does.
 *
 * The last two cases are not a conflict between replicas but between this
 * replica and its own sync cycle: a write that lands after the push drain
 * reached its tail, whose row the pull is about to overwrite with the peer's
 * older state. Push-first (T8) narrowed that window to the cycle's own duration
 * and could not remove it. Both halves of what is left are here — the page in
 * flight, and the page committing — because they are closed by different things.
 */

import { describe, expect, it } from 'vitest'
import { authority } from './authority'
import { type CursorSlot, sync, versions } from './engine'
import { type Cursor, type Node, ROOT, type Store } from './store'
import { memStore } from './store.mem'
import type { Volume } from './volume'
import { storeVolume } from './volume.store'

const enc = new TextEncoder()
const dec = new TextDecoder()

/** The host-local cursor slot. A variable is the whole contract (see T8). */
function slot(): CursorSlot {
	let at: Cursor | undefined
	return {
		load: async () => at,
		save: async (cursor) => {
			at = cursor
		}
	}
}

/** One replica: its store, its cursors, and the POSIX view its user writes through. */
function replica(id: string) {
	const store = memStore()
	const pull = slot()
	const push = slot()
	return {
		store,
		opts: { replica: id, pull, push },
		vol: storeVolume(store, { mintVersion: versions(id) })
	}
}

const read = async (store: Store, path: string): Promise<string> =>
	dec.decode(await storeVolume(store).readFile(path))

const names = async (vol: Volume): Promise<string[]> =>
	(await vol.readdir('/')).map((e) => e.name).sort()

describe('sync: conflicts', () => {
	it('keeps both files when two replicas create one name, under a name the loser picks', async () => {
		const hub = authority(memStore())
		const a = replica('a')
		const b = replica('b')
		await a.vol.writeFile('/note.txt', enc.encode('from a'))
		await b.vol.writeFile('/note.txt', enc.encode('from b'))

		await sync(a.store, hub, a.opts)
		// b's push fails the name check, so it pulls the winner, renames its own
		// node to a name derived from its replica id — deterministic, so two
		// replicas conflicting on one name never collide again — and pushes that.
		await sync(b.store, hub, b.opts)
		await sync(a.store, hub, a.opts)

		for (const store of [hub, a.store, b.store]) {
			expect(await names(storeVolume(store))).toEqual(['note.txt', 'note.txt (conflict b)'])
			expect(await read(store, '/note.txt')).toBe('from a')
			expect(await read(store, '/note.txt (conflict b)')).toBe('from b')
		}
	})

	it('recreates the edited file under a new id when the delete committed first', async () => {
		const hub = authority(memStore())
		const a = replica('a')
		const b = replica('b')
		await a.vol.writeFile('/note.txt', enc.encode('one'))
		await sync(a.store, hub, a.opts)
		await sync(b.store, hub, b.opts)
		const before = (await b.store.child(ROOT, 'note.txt'))?.id

		await a.vol.rm('/note.txt')
		await sync(a.store, hub, a.opts)
		await b.vol.writeFile('/note.txt', enc.encode('two'))
		await sync(b.store, hub, b.opts)
		await sync(a.store, hub, a.opts)

		// Tombstones plus versions are what make this a different answer from a
		// plain create: the id is gone for good, and the bytes go on under a new
		// one rather than resurrecting a row the other side deleted.
		for (const store of [hub, a.store, b.store]) {
			expect(await read(store, '/note.txt')).toBe('two')
			expect(await store.get(before ?? '')).toMatchObject({ deleted: true })
			expect((await store.child(ROOT, 'note.txt'))?.id).not.toBe(before)
		}
	})

	it('takes the loser of an edit/edit race as the last writer, on the base it lost to', async () => {
		const hub = authority(memStore())
		const a = replica('a')
		const b = replica('b')
		await a.vol.writeFile('/note.txt', enc.encode('one'))
		await sync(a.store, hub, a.opts)
		await sync(b.store, hub, b.opts)

		await a.vol.writeFile('/note.txt', enc.encode('from a'))
		await b.vol.writeFile('/note.txt', enc.encode('from b'))
		// a commits between b reading the base for its push and b writing on it.
		// b's guard names a version the hub no longer holds, so nothing lands.
		let raced = false
		const contended: Store = {
			...hub,
			async get(id) {
				const row = await hub.get(id)
				if (!raced && id !== ROOT) {
					raced = true
					await sync(a.store, hub, a.opts)
				}
				return row
			}
		}

		await sync(b.store, contended, b.opts)
		await sync(a.store, hub, a.opts)

		for (const store of [hub, a.store, b.store])
			expect(await read(store, '/note.txt')).toBe('from b')
	})

	it('keeps a local edit that lands while the pull page is in flight', async () => {
		// The wide half of the window T8 could not close, and the realistic one: the
		// page is a network round trip away and the edit lands while it travels. It
		// is already there when the pull reads its base, so no guard can see it —
		// what catches it is the pull refusing to apply a page over work this
		// replica has never offered the peer.
		const { hub, b, edit } = await midCycle()
		const slow: Store = {
			...hub,
			async since(cursor) {
				const page = await hub.since(cursor)
				await edit()
				return page
			}
		}

		await sync(b.store, slow, b.opts)

		expect(await read(b.store, '/note.txt')).toBe('from b')
		expect(await read(hub, '/note.txt')).toBe('from b')
	})

	it('keeps a local edit that lands as the pull commits its page', async () => {
		// The narrow half: the base was read before the edit, so the guard names a
		// version the store no longer holds and the page is refused. Applying it
		// blind would overwrite the edit, and the next push would skip the row —
		// what it found there would be a's.
		const { hub, b, edit } = await midCycle()
		const busy: Store = {
			...b.store,
			async commit(writes, guards) {
				await edit()
				return b.store.commit(writes, guards)
			}
		}

		await sync(busy, hub, b.opts)

		expect(await read(b.store, '/note.txt')).toBe('from b')
		expect(await read(hub, '/note.txt')).toBe('from b')
	})
})

describe('sync: the replan does not disturb the quiet case', () => {
	it('stays silent when nothing conflicts', async () => {
		const hub = authority(memStore())
		const a = replica('a')
		const b = replica('b')
		await a.vol.mkdir('/docs')
		await a.vol.writeFile('/docs/note.txt', enc.encode('hello'))
		await sync(a.store, hub, a.opts)
		await sync(b.store, hub, b.opts)

		const wrote: Node[] = []
		hub.subscribe?.((rows) => wrote.push(...rows))
		await sync(a.store, hub, a.opts)
		await sync(b.store, hub, b.opts)

		expect(wrote).toEqual([])
		expect(await names(storeVolume(b.store))).toEqual(['docs'])
		expect(await read(b.store, '/docs/note.txt')).toBe('hello')
	})
})

/**
 * Two replicas in step, a's newer edit waiting at the hub, and a local edit on b
 * that has not happened yet — `edit` lands it exactly once, wherever the test
 * puts it inside b's next cycle.
 */
async function midCycle() {
	const hub = authority(memStore())
	const a = replica('a')
	const b = replica('b')
	await a.vol.writeFile('/note.txt', enc.encode('one'))
	await sync(a.store, hub, a.opts)
	await sync(b.store, hub, b.opts)
	await a.vol.writeFile('/note.txt', enc.encode('from a'))
	await sync(a.store, hub, a.opts)

	let landed = false
	return {
		hub,
		b,
		edit: async (): Promise<void> => {
			if (landed) return
			landed = true
			await b.vol.writeFile('/note.txt', enc.encode('from b'))
		}
	}
}
