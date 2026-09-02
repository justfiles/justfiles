import { describe, expect, it } from 'vitest'
import { bootstrap, type CursorSlot, sync, versions } from './engine'
import { memStore } from './mem'
import {
	BootstrapRequiredError,
	type ReceiverStore,
	receiver,
	receiverBackend,
	syncStateLock
} from './peer'
import { type Cursor, type Node, ROOT, sha256Hex } from './store'

const slot = (initial?: Cursor): CursorSlot => {
	let cursor = initial
	return {
		load: async () => cursor,
		save: async (next) => {
			cursor = next
		}
	}
}

const caughtUp = async (peer: ReturnType<typeof receiver>): Promise<Cursor> => {
	let cursor: Cursor | undefined
	for (;;) {
		const page = await peer.since(cursor)
		if (!page.next) throw new Error('receiver did not return a cursor')
		cursor = page.next
		if (page.nodes.length === 0) return cursor
	}
}

const node = (version: string): Node => ({
	id: 'note',
	parent: ROOT,
	name: 'note.txt',
	type: 'file',
	mode: 0o100644,
	mtimeNs: 1n,
	size: 0n,
	version
})

const deferred = () => {
	let resolve!: () => void
	return { promise: new Promise<void>((done) => (resolve = done)), resolve }
}

describe('leased peer cursors', () => {
	it('round-trips a signed cursor and rejects any alteration', async () => {
		const peer = receiver(memStore())
		const first = await peer.since()

		expect(first.nodes.map((row) => row.id)).toEqual([ROOT])
		expect(first.next).toBeDefined()
		expect((await peer.since(first.next)).nodes).toEqual([])

		const cursor = first.next as string
		const changed = `${cursor.slice(0, -1)}${cursor.endsWith('a') ? 'b' : 'a'}`
		await expect(peer.since(changed)).rejects.toThrow(BootstrapRequiredError)
	})

	it('opens a lease before a sync push and exposes no unleased writer', async () => {
		const local = memStore()
		const remote = memStore()
		const peer = receiver(remote)
		const cursor = await caughtUp(peer)
		const mint = versions('local')
		await local.commit([node(mint())])

		await expect(peer.commit('', [node(mint())])).rejects.toThrow(BootstrapRequiredError)
		await expect(peer.commit(cursor, [node(mint())])).rejects.toThrow(BootstrapRequiredError)
		expect(await remote.get('note')).toBeNull()
		await sync(local, peer, {
			replica: 'local',
			pull: slot(cursor),
			push: slot(),
			retries: 0
		})

		expect(await remote.get('note')).toEqual(node((await local.get('note'))?.version as string))
	})

	it('refuses an expired cursor before transferring blobs or committing rows', async () => {
		let now = 0
		const local = memStore()
		const remote = memStore()
		const peer = receiver(remote, {
			clock: () => now,
			policy: {
				cursorLeaseMs: 100,
				writeLeaseMs: 20,
				maxWriteDurationMs: 10,
				tombstoneFenceAgeMs: 100,
				tombstoneGraceMs: 31
			}
		})
		const cursor = await caughtUp(peer)
		const data = new TextEncoder().encode('offline work')
		const hash = await sha256Hex(data)
		await local.blobs.put(hash, data)
		await local.commit([{ ...node(versions('local')()), content: hash, size: BigInt(data.length) }])
		now = 101

		await expect(
			sync(local, peer, {
				replica: 'local',
				pull: slot(cursor),
				push: slot(),
				retries: 0
			})
		).rejects.toThrow(BootstrapRequiredError)
		expect(await remote.get('note')).toBeNull()
		expect(await remote.blobs.has(hash)).toBe(false)
	})

	it('renews a caught-up cursor even when the feed is quiet', async () => {
		let now = 0
		const peer = receiver(memStore(), {
			clock: () => now,
			policy: {
				cursorLeaseMs: 100,
				writeLeaseMs: 20,
				maxWriteDurationMs: 10,
				tombstoneFenceAgeMs: 100,
				tombstoneGraceMs: 31
			}
		})
		const original = await caughtUp(peer)
		now = 90
		const renewed = (await peer.since(original)).next as Cursor
		now = 101

		await expect(peer.open(original)).rejects.toThrow(BootstrapRequiredError)
		await expect(peer.open(renewed)).resolves.toBeDefined()
	})

	it('revalidates a lease for every blob put and again for row commit', async () => {
		let now = 0
		const remote = memStore()
		const peer = receiver(remote, {
			clock: () => now,
			policy: {
				cursorLeaseMs: 100,
				writeLeaseMs: 20,
				maxWriteDurationMs: 10,
				tombstoneFenceAgeMs: 100,
				tombstoneGraceMs: 31
			}
		})
		const lease = await peer.open(await caughtUp(peer))
		const first = new TextEncoder().encode('first')
		const second = new TextEncoder().encode('second')
		const firstHash = await sha256Hex(first)
		const secondHash = await sha256Hex(second)

		await peer.blobs.put(lease, firstHash, first)
		now = 21
		await expect(peer.blobs.put(lease, secondHash, second)).rejects.toThrow(BootstrapRequiredError)
		await expect(peer.commit(lease, [node(versions('local')())])).rejects.toThrow(
			BootstrapRequiredError
		)

		expect(await remote.blobs.has(firstHash)).toBe(true)
		expect(await remote.blobs.has(secondHash)).toBe(false)
		expect(await remote.get('note')).toBeNull()
	})

	it('linearizes final commit validation with a destructive state change', async () => {
		const raw = memStore()
		const entered = deferred()
		const release = deferred()
		let floor = 0
		const backend = raw[receiverBackend]
		const paused: ReceiverStore = {
			...raw,
			[receiverBackend]: {
				...backend,
				async state() {
					return { ...(await backend.state()), feedFloor: floor }
				}
			},
			async commit(writes, guards) {
				entered.resolve()
				await release.promise
				await raw.commit(writes, guards)
			}
		}
		const lock = syncStateLock()
		const peer = receiver(paused, { lock })
		const lease = await peer.open(await caughtUp(peer))

		const committing = peer.commit(lease, [node(versions('local')())])
		await entered.promise
		let resetRan = false
		const resetting = lock(async () => {
			resetRan = true
		})
		await Promise.resolve()
		expect(resetRan).toBe(false)
		release.resolve()
		await committing
		await resetting
		expect(await raw.get('note')).not.toBeNull()

		const staleLease = await peer.open(await caughtUp(peer))
		await raw.commit([{ ...node(versions('other')()), id: 'later', name: 'later.txt' }])
		const holdingReset = lock(async () => {
			floor = (await backend.state()).feedHead
			await Promise.resolve()
		})
		const refused = peer.commit(staleLease, [{ ...node(versions('local')()), id: 'refused' }])
		await holdingReset
		await expect(refused).rejects.toThrow(BootstrapRequiredError)
		expect(await raw.get('refused')).toBeNull()
	})

	it('keeps bootstrap cursors read-only until the scan reaches the feed head', async () => {
		const store = memStore()
		await store.commit(
			Array.from({ length: 129 }, (_, at) => ({
				...node(`seed:${at}`),
				id: `seed-${at}`,
				name: `seed-${at}.txt`
			}))
		)
		const peer = receiver(store)
		const first = await peer.since()

		expect(first.nodes).toHaveLength(128)
		await expect(peer.open(first.next)).rejects.toThrow(BootstrapRequiredError)
		await expect(peer.commit(first.next as Cursor, [node('local:1')])).rejects.toThrow(
			BootstrapRequiredError
		)
		const second = await peer.since(first.next)
		await expect(peer.open(second.next)).resolves.toBeDefined()
	})

	it('bootstraps authority state into a fresh store without merging stale rows', async () => {
		let now = 0
		const authority = memStore()
		await authority.commit([{ ...node('authority:1'), id: 'theirs', name: 'theirs.txt' }])
		const peer = receiver(authority, {
			clock: () => now,
			policy: {
				cursorLeaseMs: 100,
				writeLeaseMs: 20,
				maxWriteDurationMs: 10,
				tombstoneFenceAgeMs: 100,
				tombstoneGraceMs: 31
			}
		})
		const expired = await caughtUp(peer)
		const stale = memStore()
		await stale.commit([{ ...node('local:1'), id: 'stale', name: 'stale.txt' }])
		now = 101
		await expect(
			sync(stale, peer, {
				replica: 'local',
				pull: slot(expired),
				push: slot(),
				retries: 0
			})
		).rejects.toThrow(BootstrapRequiredError)

		const fresh = memStore()
		const pull = slot()
		await bootstrap(fresh, peer, pull, { lazyContent: true })
		expect(await fresh.get('theirs')).toEqual(await authority.get('theirs'))
		expect(await fresh.get('stale')).toBeNull()
		expect(await stale.get('stale')).not.toBeNull()
		await expect(peer.open(await pull.load())).resolves.toBeDefined()
	})

	it('lets symmetric peers expire and bootstrap independently', async () => {
		let now = 0
		const policy = {
			cursorLeaseMs: 100,
			writeLeaseMs: 20,
			maxWriteDurationMs: 10,
			tombstoneFenceAgeMs: 100,
			tombstoneGraceMs: 31
		}
		const a = memStore()
		const b = memStore()
		await a.commit([{ ...node('a:1'), id: 'a', name: 'a.txt' }])
		await b.commit([{ ...node('b:1'), id: 'b', name: 'b.txt' }])
		const aPeer = receiver(a, { clock: () => now, policy })
		const bPeer = receiver(b, { clock: () => now, policy })
		const cursorFromA = await caughtUp(aPeer)
		const cursorFromB = await caughtUp(bPeer)
		now = 101

		await expect(aPeer.open(cursorFromA)).rejects.toThrow(BootstrapRequiredError)
		await expect(bPeer.open(cursorFromB)).rejects.toThrow(BootstrapRequiredError)

		const freshA = memStore()
		const freshB = memStore()
		const nextFromA = slot()
		const nextFromB = slot()
		await Promise.all([
			bootstrap(freshB, aPeer, nextFromA, { lazyContent: true }),
			bootstrap(freshA, bPeer, nextFromB, { lazyContent: true })
		])

		expect(await freshA.get('b')).toEqual(await b.get('b'))
		expect(await freshB.get('a')).toEqual(await a.get('a'))
		await expect(aPeer.open(await nextFromA.load())).resolves.toBeDefined()
		await expect(bPeer.open(await nextFromB.load())).resolves.toBeDefined()
	})
})
