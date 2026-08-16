/**
 * `volume.watch` over the seam — design table A's watch row: events synthesized
 * by row diff from the commit feed.
 *
 * The scenarios of `watch.test.ts` are ported whole: it is the behaviour spec,
 * and no consumer may be able to tell this volume from the old one. One
 * behaviour DOES change, and it has its own test — the old model tagged every
 * write with a `MutationOptions.origin` and this model has no origin tags at
 * all, so a remote event is one whose row carries another replica's author
 * inside its `version`.
 *
 * Everything runs twice, over both feeds a store may offer: a push `subscribe`,
 * and a polled `since` for a store that has none. That is the point of leaving
 * `subscribe` optional in the seam, so it is the point of testing it here.
 */

import { describe, expect, it } from 'vitest'
import { type Node, ROOT, type Store } from './store'
import { memStore } from './store.mem'
// `chroot` is written against the `Volume` interface and nothing else, so the
// old volume's one wraps this one unchanged — including its watch root.
import { chroot, WATCH_BURST_MS } from './volume'
import { storeVolume } from './volume.store'

const enc = new TextEncoder()

/** Long enough that either feed WOULD have delivered — poll tick, then window. */
const settle = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, WATCH_BURST_MS * 4))

/**
 * For what must arrive: how fast it arrives is the feed's business, not the
 * spec's. The deadline is loose on purpose — a delivery costs a poll tick and a
 * window, and this suite runs beside 180 other files on a machine that may stall
 * either of them. Nothing here asserts latency, so waiting longer weakens no
 * claim; the rate BOUND has its own test, which does not go through this.
 */
async function waitFor(assertion: () => void): Promise<void> {
	const deadline = Date.now() + WATCH_BURST_MS * 40
	let last: unknown
	for (;;) {
		try {
			return assertion()
		} catch (e) {
			last = e
			if (Date.now() > deadline) throw last
			await new Promise((resolve) => setTimeout(resolve, WATCH_BURST_MS / 5))
		}
	}
}

/** The row a path names, straight out of the store — versions unmasked. */
async function rowAt(store: Store, path: string): Promise<Node> {
	let node: Node | null = await store.get(ROOT)
	for (const name of path.split('/').filter((s) => s !== '')) {
		node = await store.child(node?.id ?? ROOT, name)
		if (node === null) throw new Error(`no row at ${path}`)
	}
	if (node === null) throw new Error(`no row at ${path}`)
	return node
}

const feeds: [string, () => Store][] = [
	['a subscribe feed', () => memStore()],
	// The same store with its push feed hidden: `watch` falls back to polling
	// `since`, which every store has.
	['a polled since feed', () => ({ ...memStore(), subscribe: undefined })]
]

describe.each(feeds)('volume.watch over %s', (_feed, newStore) => {
	it('fires on content and meta change of the watched path', async () => {
		const vol = storeVolume(newStore())
		await vol.writeFile('/s.json', enc.encode('1'))

		let fired = 0
		let lastSource: string | undefined = 'sentinel'
		const off = await vol.watch('/s.json', (e) => {
			fired++
			lastSource = e.source
		})

		await vol.writeFile('/s.json', enc.encode('2'))
		await waitFor(() => expect(fired).toBe(1))
		expect(lastSource).toBeUndefined()

		await vol.chmod('/s.json', 0o600)
		await waitFor(() => expect(fired).toBe(2))

		off()
		await vol.writeFile('/s.json', enc.encode('3'))
		await settle()
		expect(fired).toBe(2)
	})

	it('reports a row another replica authored as a remote event', async () => {
		const store = newStore()
		const vol = storeVolume(store)
		await vol.writeFile('/s.json', enc.encode('1'))

		let lastSource: string | undefined
		await vol.watch('/s.json', (e) => {
			lastSource = e.source
		})

		// What the engine's pull commits: a whole row minted by another replica.
		// There is no origin to tag it with — the version says who wrote it.
		const row = await rowAt(store, '/s.json')
		await store.commit([{ ...row, size: 5n, version: 'agent-7:42' }])
		await waitFor(() => expect(lastSource).toBe('remote'))
	})

	it('coalesces the commits of one turn into one event', async () => {
		const store = newStore()
		const vol = storeVolume(store)
		await vol.writeFile('/s.json', enc.encode('1'))

		let fired = 0
		await vol.watch('/s.json', () => {
			fired++
		})

		// Two commits in the same synchronous turn → one delivery.
		const row = await rowAt(store, '/s.json')
		void store.commit([{ ...row, mode: 0o100600, version: 'agent-7:1' }])
		void store.commit([{ ...row, mode: 0o100600, size: 9n, version: 'agent-7:2' }])
		await settle()
		expect(fired).toBe(1)
	})

	it('re-resolves when the path is rebound (delete + recreate)', async () => {
		const vol = storeVolume(newStore())
		await vol.writeFile('/r.json', enc.encode('1'))

		let fired = 0
		await vol.watch('/r.json', () => {
			fired++
		})

		await vol.rm('/r.json')
		await waitFor(() => expect(fired).toBeGreaterThanOrEqual(1))
		const afterDelete = fired

		await vol.writeFile('/r.json', enc.encode('2'))
		await waitFor(() => expect(fired).toBeGreaterThan(afterDelete))

		// A plain content edit on the *new* row must still fire — proves the watch
		// re-resolved the path to the fresh id.
		const settled = fired
		await vol.writeFile('/r.json', enc.encode('3'))
		await waitFor(() => expect(fired).toBe(settled + 1))
		await settle()
		expect(fired).toBe(settled + 1)
	})

	it('re-resolves on rename/replace of the watched path', async () => {
		const vol = storeVolume(newStore())
		await vol.writeFile('/dest.json', enc.encode('old'))
		await vol.writeFile('/src.json', enc.encode('new'))

		let fired = 0
		await vol.watch('/dest.json', () => {
			fired++
		})

		await vol.rename('/src.json', '/dest.json')
		await waitFor(() => expect(fired).toBeGreaterThanOrEqual(1))

		// Editing the content that now backs /dest.json fires via the rebound row.
		const settled = fired
		await vol.writeFile('/dest.json', enc.encode('newer'))
		await waitFor(() => expect(fired).toBe(settled + 1))
		await settle()
		expect(fired).toBe(settled + 1)
	})

	it('rebinds when the watched path is a symlink that is unlinked', async () => {
		const vol = storeVolume(newStore())
		await vol.writeFile('/target.json', enc.encode('1'))
		await vol.symlink('/target.json', '/link.json')

		let fired = 0
		await vol.watch('/link.json', () => {
			fired++
		})

		// The path resolves THROUGH the link, so the row being watched is the
		// target's — and unlinking the link touches neither it nor any other row
		// but the tombstone standing at the watched name.
		await vol.rm('/link.json')
		await waitFor(() => expect(fired).toBe(1))

		// The path is gone, so what it used to point at is no longer its business.
		await vol.writeFile('/target.json', enc.encode('2'))
		await settle()
		expect(fired).toBe(1)
	})

	it('binds a path whose parent directory does not exist yet', async () => {
		const vol = storeVolume(newStore())

		let fired = 0
		await vol.watch('/state/app.json', () => {
			fired++
		})

		// Creating an unrelated dir must not fire (the path still does not resolve).
		await vol.mkdir('/other')
		await settle()
		expect(fired).toBe(0)

		// Creating the missing parent then the file binds the watch and fires.
		await vol.mkdir('/state')
		await vol.writeFile('/state/app.json', enc.encode('1'))
		await waitFor(() => expect(fired).toBeGreaterThanOrEqual(1))

		// A later content edit fires via the now-bound row.
		const settled = fired
		await vol.writeFile('/state/app.json', enc.encode('2'))
		await waitFor(() => expect(fired).toBe(settled + 1))
		await settle()
		expect(fired).toBe(settled + 1)
	})
})

describe('volume.watch over a store that changes lineage', () => {
	// Only the polled feed carries a cursor, so only it can be fenced by one. The
	// store is replaced under a LIVE watch — the case rule 11 exists for: its
	// cursor names a position in a lineage that is gone, so every read from it
	// fails for good and the watch has to start over rather than retry.
	function replaceable(): { store: Store; replace: () => void } {
		const before = memStore()
		const after = memStore() // a second lineage: it rejects the first one's cursors
		let reset = false
		const at = (): Store => (reset ? after : before)
		return {
			store: {
				get: (id) => at().get(id),
				child: (parent, name) => at().child(parent, name),
				children: (parent, cursor) => at().children(parent, cursor),
				since: (cursor) => at().since(cursor),
				commit: (writes, guards) => at().commit(writes, guards),
				blobs: before.blobs
			},
			replace: () => {
				reset = true
			}
		}
	}

	it('starts again from the empty cursor and converges', async () => {
		const { store, replace } = replaceable()
		const vol = storeVolume(store)
		await vol.mkdir('/notes')

		let fired = 0
		await vol.watch('/notes', () => fired++, { recursive: true })
		replace()

		// Nothing is written, and that IS the point: the tree the watch was
		// showing has been replaced wholesale, so all of it is news.
		await waitFor(() => expect(fired).toBe(1))
		expect(await vol.exists('/notes')).toBe(false)
	})

	it('rebinds a single-path watch, which no replayed row could reach', async () => {
		const { store, replace } = replaceable()
		const vol = storeVolume(store)
		await vol.writeFile('/state.json', enc.encode('1'))

		let fired = 0
		let lastSource: string | undefined = 'sentinel'
		await vol.watch('/state.json', (e) => {
			fired++
			lastSource = e.source
		})
		replace()

		// A subtree watch converges on its own, because ROOT is on its way in and
		// every store's feed carries it. This one is bound to ids from the lineage
		// that is gone, and the replacement's rows can never match them — so being
		// told the feed restarted is the only way it can learn its file is gone.
		await waitFor(() => expect(fired).toBe(1))
		expect(await vol.exists('/state.json')).toBe(false)
		// Nothing this replica wrote took the file away.
		expect(lastSource).toBe('remote')
	})
})

describe.each(feeds)('volume.watch recursive over %s', (_feed, newStore) => {
	it('follows a symlinked root to where the events actually land', async () => {
		const vol = storeVolume(newStore())
		await vol.mkdir('/notes/trips', { recursive: true })
		await vol.symlink('/notes', '/alias')

		let fired = 0
		// The app's own reads through /alias land on /notes, so its watch must too.
		await vol.watch('/alias', () => fired++, { recursive: true })

		await vol.writeFile('/notes/trips/kyoto.md', enc.encode('go'))
		await waitFor(() => expect(fired).toBe(1))

		await vol.writeFile('/elsewhere.md', enc.encode('x'))
		await settle()
		expect(fired).toBe(1)
	})

	it('watches a root that does not exist yet', async () => {
		const vol = storeVolume(newStore())

		let fired = 0
		// What frieren's dock does: watch `/applications` before anything has seeded
		// it. Nothing resolves through yet, so the walk holds the deepest row it did
		// reach — and the create that binds the root stamps exactly that row.
		await vol.watch('/applications', () => fired++, { recursive: true })

		await vol.mkdir('/applications')
		// The root's own creation counts: it IS the watched path.
		await waitFor(() => expect(fired).toBe(1))

		await vol.writeFile('/applications/app.js', enc.encode('x'))
		await waitFor(() => expect(fired).toBe(2))

		// …and a sibling subtree's churn (an import writing a thousand notes) stays out.
		await vol.mkdir('/notes', { recursive: true })
		await vol.writeFile('/notes/kyoto.md', enc.encode('go'))
		await settle()
		expect(fired).toBe(2)
	})

	it('does not miss the create that binds its root while it is still binding', async () => {
		const store = newStore()
		const writer = storeVolume(store)

		// Slip the create in AFTER the watch has read the tree and BEFORE it could
		// be told anything. It is the one window that costs more than an event: the
		// create it misses is the one that would have bound its root, and every
		// later write inside that root stamps a directory the watch never heard of,
		// so it would stay silent for good rather than for a moment.
		let raced: Promise<void> | undefined
		const racing: Store = {
			...store,
			async child(parent, name) {
				const found = await store.child(parent, name)
				raced ??= writer.mkdir('/applications')
				await raced
				return found
			}
		}

		let fired = 0
		await storeVolume(racing).watch('/applications', () => fired++, { recursive: true })
		// Held while binding, then replayed against the bound state: the root came
		// into being, which is a wake.
		await waitFor(() => expect(fired).toBe(1))

		// The one that matters: the watch found the root it never saw created.
		await writer.writeFile('/applications/app.js', enc.encode('x'))
		await waitFor(() => expect(fired).toBe(2))
	})

	it('wakes when an ancestor moves, taking the subtree with it', async () => {
		const vol = storeVolume(newStore())
		await vol.mkdir('/notes/trips', { recursive: true })
		await vol.writeFile('/notes/trips/kyoto.md', enc.encode('go'))

		let fired = 0
		await vol.watch('/notes/trips', () => fired++, { recursive: true })

		// Renaming an ancestor empties the watched subtree without touching a single
		// row inside it — a child's location is (parent, name), and neither changed,
		// so the moved row is the ONLY event there is.
		await vol.rename('/notes', '/archive')
		await waitFor(() => expect(fired).toBe(1))
		expect(await vol.exists('/notes/trips')).toBe(false)

		// A path that merely shares a prefix is not an ancestor.
		await vol.mkdir('/notes-archive/trips', { recursive: true })
		await vol.writeFile('/notes-archive/trips/x.md', enc.encode('x'))
		await settle()
		expect(fired).toBe(1)

		// Moving it back is the same story in reverse: the subtree reappears.
		await vol.rename('/archive', '/notes')
		await waitFor(() => expect(fired).toBe(2))
		expect(await vol.exists('/notes/trips')).toBe(true)
	})

	it('resolves a non-canonical watch root the way every other operation does', async () => {
		const vol = storeVolume(newStore())
		await vol.mkdir('/notes/trips', { recursive: true })

		let fired = 0
		// The same subtree, spelled the long way round — `stat`/`scan` resolve this to
		// /notes, so a watch must not silently watch nothing instead.
		await vol.watch('/notes/trips/../', () => fired++, { recursive: true })

		await vol.writeFile('/notes/kyoto.md', enc.encode('go'))
		await waitFor(() => expect(fired).toBe(1))

		await vol.writeFile('/elsewhere.md', enc.encode('x'))
		await settle()
		expect(fired).toBe(1)
	})

	it('is scoped to the watched subtree', async () => {
		const vol = storeVolume(newStore())
		await vol.mkdir('/notes/trips', { recursive: true })
		await vol.mkdir('/state', { recursive: true })
		const notes = chroot(vol, '/notes')

		let fired = 0
		// What an app gets: a recursive watch on its own chroot's root.
		await notes.watch('/', () => fired++, { recursive: true })

		// The kernel writing an app's state file is not this app's business.
		await vol.writeFile('/state/app.json', enc.encode('{}'))
		await settle()
		expect(fired).toBe(0)

		// A create inside the subtree — however deep — is.
		await notes.writeFile('/trips/kyoto.md', enc.encode('go'))
		await waitFor(() => expect(fired).toBe(1))

		// Renaming out of scope still fires (the entry left the listing).
		await vol.rename('/notes/trips/kyoto.md', '/state/kyoto.md')
		await waitFor(() => expect(fired).toBe(2))

		// A sibling prefix must not be mistaken for the subtree.
		await vol.mkdir('/notesy', { recursive: true })
		await vol.writeFile('/notesy/x.md', enc.encode('x'))
		await settle()
		expect(fired).toBe(2)
	})

	it('fires on a structural change anywhere in the tree, not on content edits', async () => {
		const vol = storeVolume(newStore())
		await vol.mkdir('/deep/nested', { recursive: true })
		await vol.writeFile('/a.txt', enc.encode('1'))

		let fired = 0
		let lastSource: string | undefined = 'sentinel'
		await vol.watch(
			'/',
			(e) => {
				fired++
				lastSource = e.source
			},
			{ recursive: true }
		)

		// A nested create fires — a single-path watch on '/' never would.
		await vol.writeFile('/deep/nested/b.txt', enc.encode('1'))
		await waitFor(() => expect(fired).toBe(1))
		expect(lastSource).toBeUndefined()

		// A content edit to an existing file keeps the entry set identical → no fire.
		// It writes ONE row, and no directory: that is the whole distinction.
		await vol.writeFile('/a.txt', enc.encode('2'))
		await settle()
		expect(fired).toBe(1)

		// Remove and rename reshape the tree → fire (counts coalesce per window).
		await vol.rm('/deep/nested/b.txt')
		await waitFor(() => expect(fired).toBeGreaterThan(1))

		const settled = fired
		await vol.writeFile('/c.txt', enc.encode('1'))
		await vol.rename('/c.txt', '/d.txt')
		await waitFor(() => expect(fired).toBeGreaterThan(settled))
	})

	it('reports a remote change whose parent stamp a local write overwrote', async () => {
		const store = newStore()
		let n = 0
		// A known author, so the test can commit a row this volume will read as its own.
		const vol = storeVolume(store, { mintVersion: () => `me:${++n}` })
		await vol.mkdir('/notes')
		const dir = await rowAt(store, '/notes')

		let fired = 0
		let lastSource: string | undefined = 'sentinel'
		await vol.watch(
			'/notes',
			(e) => {
				fired++
				lastSource = e.source
			},
			{ recursive: true }
		)

		// Both commits in one turn, so no timer can run between them: they arrive as
		// ONE window however the feed is read. What a pull commits — a foreign row
		// and the parent stamp that says the listing changed…
		await store.commit([
			{
				id: crypto.randomUUID(),
				parent: dir.id,
				name: 'kyoto.md',
				type: 'file',
				mode: 0o100644,
				mtimeNs: 2n,
				size: 2n,
				version: 'agent-7:1'
			},
			{ ...dir, mtimeNs: 2n, version: 'agent-7:2' }
		])
		// …and then a local create in the SAME directory, which rewrites that stamp.
		// A feed that carries each row once at its latest state hands the window over
		// with the remote stamp gone — the remote row is what is left to read.
		await store.commit([
			{
				id: crypto.randomUUID(),
				parent: dir.id,
				name: 'local.md',
				type: 'file',
				mode: 0o100644,
				mtimeNs: 3n,
				size: 1n,
				version: 'me:99'
			},
			{ ...dir, mtimeNs: 3n, version: 'me:100' }
		])

		await waitFor(() => expect(fired).toBe(1))
		expect(lastSource).toBe('remote')
	})

	it('reports a remote entry that left the subtree, whose stamp a local write overwrote', async () => {
		const store = newStore()
		let n = 0
		const vol = storeVolume(store, { mintVersion: () => `me:${++n}` })
		await vol.mkdir('/notes')
		await vol.mkdir('/elsewhere')
		await vol.writeFile('/notes/kyoto.md', enc.encode('go'))
		const dir = await rowAt(store, '/notes')
		const away = await rowAt(store, '/elsewhere')
		const moving = await rowAt(store, '/notes/kyoto.md')

		let fired = 0
		let lastSource: string | undefined = 'sentinel'
		await vol.watch(
			'/notes',
			(e) => {
				fired++
				lastSource = e.source
			},
			{ recursive: true }
		)

		// A remote rename OUT of the watched subtree: the moved row now points at a
		// parent outside it, so the row that says the listing lost an entry is the
		// source directory's stamp…
		await store.commit([
			{ ...moving, parent: away.id, mtimeNs: 4n, version: 'agent-7:1' },
			{ ...dir, mtimeNs: 4n, version: 'agent-7:2' },
			{ ...away, mtimeNs: 4n, version: 'agent-7:3' }
		])
		// …which a local create in that same directory then overwrites, in the same
		// turn so both land in one window. Nothing foreign is left standing inside
		// the subtree at all — and the wake is still somebody else's doing.
		await store.commit([
			{
				id: crypto.randomUUID(),
				parent: dir.id,
				name: 'local.md',
				type: 'file',
				mode: 0o100644,
				mtimeNs: 5n,
				size: 1n,
				version: 'me:99'
			},
			{ ...dir, mtimeNs: 5n, version: 'me:100' }
		])

		await waitFor(() => expect(fired).toBe(1))
		expect(lastSource).toBe('remote')
	})

	it('thins a burst of writes into a bounded number of wakes, ending on a trailing one', async () => {
		const vol = storeVolume(newStore())
		const N = 300
		await vol.mkdir('/heavy', { recursive: true })

		let fired = 0
		const unwatch = await vol.watch('/', () => fired++, { recursive: true })

		// The shape that made a heavy operation look like a frozen desktop: an import
		// awaits a store round trip per entry, so a watch that coalesced onto a
		// microtask delivered one wake per entry and every consumer answered each one
		// with a full re-scan. The bound is what is asserted, not a count — a wake per
		// entry is the bug, a handful is the fix.
		const started = Date.now()
		for (let i = 0; i < N; i++) await vol.writeFile(`/heavy/f${i}.md`, enc.encode('x'))
		const elapsed = Date.now() - started
		await settle()
		unwatch()

		// A trailing delivery is guaranteed, so the consumer always re-scans the final tree.
		expect(fired).toBeGreaterThanOrEqual(1)
		// One window's worth of wakes for the operation, plus the trailing one — never O(N).
		expect(fired).toBeLessThanOrEqual(Math.ceil(elapsed / WATCH_BURST_MS) + 2)
		expect(fired).toBeLessThan(N)
	})

	it('wakes once for a recursive removal — the seam makes it one commit', async () => {
		const vol = storeVolume(newStore())
		await vol.mkdir('/heavy', { recursive: true })
		for (let i = 0; i < 50; i++) await vol.writeFile(`/heavy/f${i}.md`, enc.encode('x'))

		let fired = 0
		await vol.watch('/', () => fired++, { recursive: true })

		// 51 tombstones and the parent stamp go in ONE guarded commit, so there is
		// one feed entry to coalesce and nothing for the window to thin.
		await vol.rm('/heavy', { recursive: true })
		await waitFor(() => expect(fired).toBe(1))
		expect(await vol.exists('/heavy')).toBe(false)
		await settle()
		expect(fired).toBe(1)
	})
})
