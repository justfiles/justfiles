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

	it('numbers the conflict name when the first one is already taken', async () => {
		// The conflict name is never assumed free: it is probed against the authority
		// until it is, and numbered rather than re-suffixed so the answer stays a
		// name a person can read however many times this replica has lost.
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
				'note.txt (conflict b 2)',
				'note.txt (conflict b)'
			])
			expect(await read(store, '/note.txt (conflict b 2)')).toBe('from b')
		}
	})

	it('finds a free conflict name in one settlement, however many are taken', async () => {
		// A whole chain of conflict names already at the authority. Advancing one
		// suffix per refusal would spend a replan on each, so a chain longer than the
		// budget never lands at all — and the budget is not restored by a local
		// rename, only by a page that reaches the peer.
		const hub = authority(memStore())
		const a = replica('a')
		const b = replica('b')
		let taken = 'note.txt'
		await a.vol.writeFile(`/${taken}`, enc.encode('from a'))
		for (let i = 0; i < 12; i++) {
			taken = `${taken} (conflict b)`
			await a.vol.writeFile(`/${taken}`, enc.encode('from a'))
		}
		await sync(a.store, hub, a.opts)
		await b.vol.writeFile('/note.txt', enc.encode('from b'))

		await sync(b.store, hub, b.opts)
		await sync(a.store, hub, a.opts)

		for (const store of [hub, a.store, b.store]) {
			expect(await read(store, '/note.txt')).toBe('from a')
			expect(await read(store, '/note.txt (conflict b 2)')).toBe('from b')
		}
	})

	it('skips a conflict name this replica holds but has not pushed yet', async () => {
		// The peer is the arbiter, but it cannot see what has not reached it. A name
		// free at the authority and taken locally is the one name the rename must
		// not pick: the next push would claim it twice in one batch, which the
		// authority refuses as a whole — and neither name is taken remotely, so no
		// settlement can tell why.
		const hub = authority(memStore())
		const a = replica('a')
		const b = replica('b')
		await a.vol.writeFile('/note.txt', enc.encode('from a'))
		await sync(a.store, hub, a.opts)
		// b has never synced, so both of these are its own and neither has been sent.
		await b.vol.writeFile('/note.txt', enc.encode('from b'))
		await b.vol.writeFile('/note.txt (conflict b)', enc.encode('older from b'))

		await sync(b.store, hub, b.opts)
		await sync(a.store, hub, a.opts)

		for (const store of [hub, a.store, b.store]) {
			expect(await read(store, '/note.txt')).toBe('from a')
			expect(await read(store, '/note.txt (conflict b)')).toBe('older from b')
			expect(await read(store, '/note.txt (conflict b 2)')).toBe('from b')
		}
	})

	it('gives two rows losing one name two different names', async () => {
		// Rule 1 lets a replica hold two live rows for one `(parent, name)` — it says
		// which one is visible, not that it cannot happen — so a refused page may
		// carry both. Renaming them by the same rule gives them the same answer, and
		// the next push claims that name twice in one batch.
		const hub = authority(memStore())
		const a = replica('a')
		const b = replica('b')
		await a.vol.writeFile('/note.txt', enc.encode('from a'))
		await sync(a.store, hub, a.opts)

		const mint = versions('b')
		const twin = (id: string): Node => ({
			id,
			parent: ROOT,
			name: 'note.txt',
			type: 'file',
			mode: 0o100644,
			mtimeNs: 0n,
			size: 0n,
			version: mint()
		})
		await b.store.commit([twin('b1'), twin('b2')])

		await sync(b.store, hub, b.opts)
		await sync(a.store, hub, a.opts)

		for (const store of [hub, a.store, b.store]) {
			expect(await names(storeVolume(store))).toEqual([
				'note.txt',
				'note.txt (conflict b 2)',
				'note.txt (conflict b)'
			])
			expect((await store.child(ROOT, 'note.txt'))?.id).not.toBe('b1')
		}
	})

	it('settles two rows claiming one name even when the peer holds neither', async () => {
		// The same duplicate as above with nobody at the peer to lose to. Asking only
		// what the peer holds answers "nothing" for both rows and fixes neither, so
		// the page is refused for its own duplicate for ever. The tie-break is rule
		// 1's, applied to the page: the lowest id keeps the name.
		const hub = authority(memStore())
		const a = replica('a')
		const b = replica('b')
		const mint = versions('b')
		const twin = (id: string): Node => ({
			id,
			parent: ROOT,
			name: 'note.txt',
			type: 'file',
			mode: 0o100644,
			mtimeNs: 0n,
			size: 0n,
			version: mint()
		})
		await b.store.commit([twin('b1'), twin('b2')])

		await sync(b.store, hub, b.opts)
		await sync(a.store, hub, a.opts)

		for (const store of [hub, a.store, b.store]) {
			expect(await names(storeVolume(store))).toEqual(['note.txt', 'note.txt (conflict b)'])
			expect((await store.child(ROOT, 'note.txt'))?.id).toBe('b1')
			expect((await store.child(ROOT, 'note.txt (conflict b)'))?.id).toBe('b2')
		}
	})

	it('leaves a name with the row the peer already gave it to', async () => {
		// The page's own tie-break is the answer only where the peer has none. When
		// the peer HOLDS the name, it has already decided, and the page must not
		// overrule it — applying both rules at once renames the peer's row for
		// losing the page and the other for losing to the peer, and the name ends up
		// belonging to nobody.
		const hub = authority(memStore())
		const store = memStore()
		const mint = versions('b')
		const twin = (id: string): Node => ({
			id,
			parent: ROOT,
			name: 'note.txt',
			type: 'file',
			mode: 0o100644,
			mtimeNs: 0n,
			size: 0n,
			version: mint()
		})
		let at: Cursor | undefined
		const push = {
			load: async () => at,
			save: async (cursor: Cursor) => {
				at = cursor
			}
		}
		const opts = { replica: 'b', pull: slot(), push }
		await store.commit([twin('b2')])
		await sync(store, hub, opts)
		// A duplicate turns up locally with a LOWER id, and the push cursor is gone —
		// a crash, a cleared slot — so both rows come round again in one page.
		await store.commit([twin('b1')])
		at = undefined

		await sync(store, hub, opts)

		expect((await hub.child(ROOT, 'note.txt'))?.id).toBe('b2')
		expect((await hub.child(ROOT, 'note.txt (conflict b)'))?.id).toBe('b1')
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

	it('splits a rescue too wide for one page, and loses none of it', async () => {
		// Each refused page settles on its own, so each stands up its own copy of the
		// directory they share and the second copy takes a conflict name. The rescue
		// is therefore split, and that is the deliberate answer: carrying the id
		// between settlements is what would join them, and a settlement that is
		// refused wrote nothing — so the id it picked names a row that does not
		// exist, and the settlement after it reads that id as already dealt with and
		// buries the content instead. A split is legible and loses nothing; the
		// alternative lost files silently.
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
			const vol = storeVolume(store)
			const dirs = await names(vol)
			expect(dirs).toEqual(['docs', 'docs (conflict b)'])
			// Split, but whole: every file is somewhere, and each still reads back.
			// WHICH side any one of them lands on is a page boundary, not a promise.
			const found = new Map<string, string>()
			for (const dir of dirs)
				for (const entry of await vol.readdir(`/${dir}`))
					found.set(entry.name, `/${dir}/${entry.name}`)
			expect(found.size).toBe(200)
			for (const i of [0, 99, 199]) {
				const path = found.get(`f${i}.txt`)
				expect(path).toBeDefined()
				expect(await read(store, path ?? '')).toBe(`${i}`)
			}
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
