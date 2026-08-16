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
import { type Cursor, GuardError, type Node, ROOT, type Store } from './store'
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

	it('keeps conflicting a second time on the same name, under a longer one', async () => {
		// The conflict name is not assumed free — it is derived from the row the
		// AUTHORITY refused, and that row already carries the last rename. So a
		// replica that loses the same name twice suffixes what it was renamed to,
		// rather than proposing an occupied name for ever. Each replan strictly
		// lengthens the name, so there is no fixpoint to spin on.
		const hub = authority(memStore())
		const a = replica('a')
		const b = replica('b')
		// The name b would ask for is already somebody else's before it asks.
		await a.vol.writeFile('/note.txt', enc.encode('from a'))
		await a.vol.writeFile('/note.txt (conflict b)', enc.encode('also from a'))
		await sync(a.store, hub, a.opts)
		await b.vol.writeFile('/note.txt', enc.encode('from b'))

		await sync(b.store, hub, b.opts)
		await sync(a.store, hub, a.opts)

		for (const store of [hub, a.store, b.store]) {
			expect(await names(storeVolume(store))).toEqual([
				'note.txt',
				'note.txt (conflict b)',
				'note.txt (conflict b) (conflict b)'
			])
			expect(await read(store, '/note.txt (conflict b) (conflict b)')).toBe('from b')
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

	it('rescues what one replica put inside a directory another replica deleted', async () => {
		// The same conflict as edit-vs-delete, one level up: the node that was
		// buried is the CONTAINER of this replica's work. Recreating it alone is not
		// enough — the work inside it still names the buried id, and a row whose
		// parent is a tombstone is refused for ever, taking every row sharing its
		// page down with it.
		const hub = authority(memStore())
		const a = replica('a')
		const b = replica('b')
		await a.vol.mkdir('/docs')
		await a.vol.writeFile('/docs/old.txt', enc.encode('from a'))
		await sync(a.store, hub, a.opts)
		await sync(b.store, hub, b.opts)

		await a.vol.rm('/docs', { recursive: true })
		await sync(a.store, hub, a.opts)
		await b.vol.writeFile('/docs/new.txt', enc.encode('from b'))

		await sync(b.store, hub, b.opts)
		await sync(a.store, hub, a.opts)

		for (const store of [hub, a.store, b.store]) {
			expect(await read(store, '/docs/new.txt')).toBe('from b')
			// And the delete still won everything it actually covered: rescuing the
			// container must not drag the buried subtree back with it.
			expect(await storeVolume(store).exists('/docs/old.txt')).toBe(false)
		}
	})

	it('stands up the whole buried path in one go, however deep it was', async () => {
		// The nested case, and the reason the rescue walks rather than steps.
		// Writing a file deep inside stamps only its OWN directory, so that is the
		// single row the refused page names — and standing that back up alone leaves
		// it parented on the tombstone of ITS parent, moving the refusal one level
		// up. Level by level it would converge, at a replan a level, and a path
		// deeper than the replan budget would never converge at all. So the walk
		// goes straight to the first ancestor the peer still has.
		const deep = Array.from({ length: 12 }, (_, i) => `d${i}`) // deeper than the replan budget
		const path = `/${deep.join('/')}`
		const hub = authority(memStore())
		const a = replica('a')
		const b = replica('b')
		for (let i = 1; i <= deep.length; i++) await a.vol.mkdir(`/${deep.slice(0, i).join('/')}`)
		await a.vol.writeFile(`${path}/old.txt`, enc.encode('from a'))
		await sync(a.store, hub, a.opts)
		await sync(b.store, hub, b.opts)

		await a.vol.rm(`/${deep[0]}`, { recursive: true })
		await sync(a.store, hub, a.opts)
		await b.vol.writeFile(`${path}/new.txt`, enc.encode('from b'))

		await sync(b.store, hub, b.opts)
		await sync(a.store, hub, a.opts)

		for (const store of [hub, a.store, b.store]) {
			expect(await read(store, `${path}/new.txt`)).toBe('from b')
			expect(await storeVolume(store).exists(`${path}/old.txt`)).toBe(false)
		}
	})

	it('keeps an offline edit when the peer replaced the very file it edited', async () => {
		// Delete and re-create of one name at the peer, both before the edit is
		// offered. The buried id's content has to go somewhere, and the name it
		// wants is occupied by a node that has nothing to do with it — so this is
		// edit-vs-delete and create-vs-create at once, and taking the standing row
		// as the edit's new home would drop the edit entirely.
		const hub = authority(memStore())
		const a = replica('a')
		const b = replica('b')
		await a.vol.writeFile('/note.txt', enc.encode('one'))
		await sync(a.store, hub, a.opts)
		await sync(b.store, hub, b.opts)

		await a.vol.rm('/note.txt')
		await a.vol.writeFile('/note.txt', enc.encode('from a'))
		await sync(a.store, hub, a.opts)
		// b edits the id it still knows about, which is the buried one.
		await b.vol.writeFile('/note.txt', enc.encode('from b'))

		await sync(b.store, hub, b.opts)
		await sync(a.store, hub, a.opts)

		for (const store of [hub, a.store, b.store]) {
			expect(await read(store, '/note.txt')).toBe('from a')
			expect(await read(store, '/note.txt (conflict b)')).toBe('from b')
		}
	})

	it('stands one directory back up for a subtree too wide for a single page', async () => {
		// Each refused page meets the same buried directory, and each would stand up
		// its own copy of it if the mapping did not outlive the page — leaving the
		// rescued rows split across a `docs` and a `docs (conflict b)`. Nothing is
		// lost either way; this is about not fragmenting what the user had. The peer
		// cannot settle it, because the first copy is still only local when the next
		// page is refused.
		const hub = authority(memStore())
		const a = replica('a')
		const b = replica('b')
		await a.vol.mkdir('/docs')
		await sync(a.store, hub, a.opts)
		await sync(b.store, hub, b.opts)

		await a.vol.rm('/docs', { recursive: true })
		await sync(a.store, hub, a.opts)
		for (let i = 0; i < 200; i++) await b.vol.writeFile(`/docs/f${i}.txt`, enc.encode(`${i}`))

		await sync(b.store, hub, b.opts)
		await sync(a.store, hub, a.opts)

		for (const store of [hub, a.store, b.store]) {
			expect(await names(storeVolume(store))).toEqual(['docs'])
			expect((await storeVolume(store).readdir('/docs')).length).toBe(200)
		}
	})

	it('does not settle over a local write that lands while it is deciding', async () => {
		// The rows a settlement rewrites came off the feed before the push, and
		// deciding what to do with them takes reads at the peer. A local write in
		// that window makes them stale, and writing the rewrite blind would put the
		// old content back under the new name — sync reporting success while the
		// user's newest edit disappears.
		const hub = authority(memStore())
		const a = replica('a')
		const b = replica('b')
		await a.vol.writeFile('/note.txt', enc.encode('from a'))
		await sync(a.store, hub, a.opts)
		await b.vol.writeFile('/note.txt', enc.encode('from b'))

		let landed = false
		const slow: Store = {
			...hub,
			async child(parent, name) {
				const found = await hub.child(parent, name)
				if (!landed) {
					landed = true
					await b.vol.writeFile('/note.txt', enc.encode('newer from b'))
				}
				return found
			}
		}

		await sync(b.store, slow, b.opts)
		await sync(a.store, hub, a.opts)

		expect(landed).toBe(true)
		for (const store of [hub, a.store, b.store]) {
			expect(await read(store, '/note.txt')).toBe('from a')
			expect(await read(store, '/note.txt (conflict b)')).toBe('newer from b')
		}
	})

	it('re-mints a revival whose commit was refused, instead of trusting the first one', async () => {
		// A settlement that is refused wrote nothing, so the id it had picked for the
		// rescued content stands for a row that does not exist. Remembering it across
		// the replan is worse than forgetting: the next settlement sees the id as
		// already handled, emits no row for it, and goes on to adopt the peer's
		// tombstone — burying the content it was called to save.
		const hub = authority(memStore())
		const a = replica('a')
		const b = replica('b')
		await a.vol.writeFile('/note.txt', enc.encode('one'))
		await sync(a.store, hub, a.opts)
		await sync(b.store, hub, b.opts)

		await a.vol.rm('/note.txt')
		await sync(a.store, hub, a.opts)
		await b.vol.writeFile('/note.txt', enc.encode('from b'))

		// A write lands after the settlement reads the row it is about to copy, so
		// its guarded commit is refused and the whole cycle replans.
		let landed = false
		const busy: Store = {
			...b.store,
			async get(id) {
				const row = await b.store.get(id)
				if (!landed && row && !row.deleted) {
					landed = true
					await b.vol.writeFile('/note.txt', enc.encode('newest from b'))
				}
				return row
			}
		}

		await sync(busy, hub, b.opts)
		await sync(a.store, hub, a.opts)

		expect(landed).toBe(true)
		for (const store of [hub, a.store, b.store])
			expect(await read(store, '/note.txt')).toBe('newest from b')
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

describe('sync: the replan budget', () => {
	it('is spent only on replans that land nothing', async () => {
		// A wide sync can meet a rejection on more pages than the budget has
		// entries, resolve every one of them, and still be cut off — if the budget
		// counts rejections rather than stalls. It is a livelock stop: a page that
		// lands says the last rejection is behind us, whatever it was.
		const hub = authority(memStore())
		const b = replica('b')
		const mint = versions('b')
		const rows = Array.from({ length: 12 * 128 }, (_, i) => ({
			id: `n${i}`,
			parent: ROOT,
			name: `f${i}.txt`,
			type: 'file' as const,
			mode: 0o100644,
			mtimeNs: 0n,
			size: 0n,
			version: mint()
		}))
		await b.store.commit(rows)

		// One refusal per page, then it takes the same page on the replan.
		const seen = new Set<string>()
		const grudging: Store = {
			...hub,
			async commit(writes, guards) {
				const page = writes[0]?.id
				if (page !== undefined && !seen.has(page)) {
					seen.add(page)
					throw new GuardError('not this page, not yet')
				}
				return hub.commit(writes, guards)
			}
		}

		await sync(b.store, grudging, b.opts)

		expect(seen.size).toBeGreaterThan(8)
		expect((await storeVolume(hub).readdir('/')).length).toBe(rows.length)
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
