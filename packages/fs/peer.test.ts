import { describe, expect, it } from 'vitest'
import { bootstrap, type CursorSlot, sync, versions } from './engine'
import { memStore } from './mem'
import { BootstrapRequiredError, receiver } from './peer'
import { type ReceiverBackend, receiverBackend, withSyncCursor } from './peer.internal'
import { type Cursor, type Guard, type Node, ROOT, type Store, sha256Hex } from './store'
import { syncStateLock } from './syncState'

const MAX_OFFLINE_MS = 30 * 24 * 60 * 60 * 1_000

const slot = (initial?: Cursor): CursorSlot & { value(): Cursor | undefined } => {
	let cursor = initial
	return {
		load: async () => cursor,
		save: async (next) => {
			cursor = next
		},
		value: () => cursor
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

const node = (version: string, id = 'note'): Node => ({
	id,
	parent: ROOT,
	name: `${id}.txt`,
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

describe('receiver cursor tokens', () => {
	it('round-trips a signed cursor and rejects any alteration', async () => {
		const peer = receiver(memStore())
		const first = await peer.since()

		expect(first.nodes.map((row) => row.id)).toEqual([ROOT])
		expect((await peer.since(first.next)).nodes).toEqual([])

		const cursor = first.next as string
		const changed = `${cursor.slice(0, -1)}${cursor.endsWith('a') ? 'b' : 'a'}`
		await expect(peer.since(changed)).rejects.toThrow(BootstrapRequiredError)
	})

	it('uses the durable pull cursor for writes and rejects a missing token', async () => {
		const raw = memStore()
		const protectedStore = receiver(raw)

		await expect(protectedStore.commit([node('local:1')])).rejects.toThrow(BootstrapRequiredError)
		expect(await raw.get('note')).toBeNull()

		const cursor = await caughtUp(protectedStore)
		const local = memStore()
		const write = node(versions('local')())
		await local.commit([write])
		let remoteId: string | undefined
		const pull = slot(cursor)
		pull.identify = async (id) => {
			remoteId = id
		}
		await sync(local, protectedStore, {
			replica: 'local',
			pull,
			push: slot(),
			retries: 0
		})
		expect(await raw.get('note')).toEqual(write)
		expect(remoteId).toMatch(/^[0-9a-f-]{36}$/)
	})

	it('refuses an expired cursor before transferring blobs or rows', async () => {
		let now = 0
		const local = memStore()
		const raw = memStore()
		const peer = receiver(raw, { clock: () => now })
		const cursor = await caughtUp(peer)
		const data = new TextEncoder().encode('offline work')
		const hash = await sha256Hex(data)
		await local.blobs.put(hash, data)
		await local.commit([{ ...node(versions('local')()), content: hash, size: BigInt(data.length) }])
		now = MAX_OFFLINE_MS

		await expect(
			sync(local, peer, {
				replica: 'local',
				pull: slot(cursor),
				push: slot(),
				retries: 0
			})
		).rejects.toMatchObject({ peerId: expect.any(String), winnerId: expect.any(String) })
		expect(await raw.get('note')).toBeNull()
		expect(await raw.blobs.has(hash)).toBe(false)
	})

	it('renews expiry only after reaching the feed head', async () => {
		let now = 0
		const raw = memStore()
		await raw.commit(Array.from({ length: 257 }, (_, at) => node(`seed:${at}`, `seed-${at}`)))
		const peer = receiver(raw, { clock: () => now })
		const first = await peer.since()
		expect(first.nodes).toHaveLength(128)

		now = MAX_OFFLINE_MS - 10
		const second = await peer.since(first.next)
		expect(second.nodes).toHaveLength(128)
		const last = await peer.since(second.next)

		now = MAX_OFFLINE_MS
		const old = memStore()
		await old.commit([node(versions('old')())])
		await expect(
			sync(old, peer, {
				replica: 'old',
				pull: slot(second.next),
				push: slot(),
				retries: 0
			})
		).rejects.toThrow(BootstrapRequiredError)

		const fresh = memStore()
		const write = node(versions('new')(), 'new')
		await fresh.commit([write])
		await expect(
			sync(fresh, peer, {
				replica: 'new',
				pull: slot(last.next),
				push: slot(),
				retries: 0
			})
		).resolves.toBeUndefined()
		expect(await raw.get('new')).toEqual(write)
	})

	it('serializes final write validation with destructive state changes', async () => {
		const raw = memStore()
		const entered = deferred()
		const release = deferred()
		let reset = false
		const backend = (raw as Store & { [receiverBackend]: ReceiverBackend })[receiverBackend]
		const paused = {
			...raw,
			[receiverBackend]: {
				...backend,
				async state() {
					const state = await backend.state()
					return reset ? { ...state, lineage: `${state.lineage}-reset` } : state
				}
			},
			async commit(writes: Node[], guards?: Guard[]) {
				entered.resolve()
				await release.promise
				await raw.commit(writes, guards)
			}
		}
		const lock = syncStateLock()
		const peer = receiver(paused, { lock })
		const pull = slot(await caughtUp(peer))
		const bound = withSyncCursor(peer, pull)

		const committing = bound.commit([node('local:1')])
		await entered.promise
		let resetRan = false
		const resetting = lock(async () => {
			reset = true
			resetRan = true
		})
		await Promise.resolve()
		expect(resetRan).toBe(false)
		release.resolve()
		await committing
		await resetting

		await expect(bound.commit([node('local:2', 'refused')])).rejects.toThrow(BootstrapRequiredError)
		expect(await raw.get('refused')).toBeNull()
	})

	it('bootstraps into a fresh store without merging stale rows', async () => {
		const authority = memStore()
		await authority.commit([node('authority:1', 'theirs')])
		const peer = receiver(authority)
		const stale = memStore()
		await stale.commit([node('local:1', 'stale')])
		const fresh = memStore()
		const pull = slot()

		await bootstrap(fresh, peer, pull, { lazyContent: true })

		expect(await fresh.get('theirs')).toEqual(await authority.get('theirs'))
		expect(await fresh.get('stale')).toBeNull()
		expect(await stale.get('stale')).not.toBeNull()
		const write = node(versions('local')(), 'local')
		await fresh.commit([write])
		await expect(
			sync(fresh, peer, {
				replica: 'local',
				pull,
				push: slot(),
				retries: 0
			})
		).resolves.toBeUndefined()
		expect(await authority.get('local')).toEqual(write)
	})

	it('refuses to bootstrap into a store that already has user rows', async () => {
		const authority = receiver(memStore())
		const local = memStore()
		await local.commit([node('local:1', 'mine')])

		await expect(bootstrap(local, authority, slot(), { lazyContent: true })).rejects.toThrow(
			BootstrapRequiredError
		)
		expect(await local.get('mine')).not.toBeNull()
	})

	it('accepts a viewpoint-independent winner and rejects any other id', async () => {
		let now = 0
		const peer = receiver(memStore(), { clock: () => now })
		const cursor = await caughtUp(peer)
		now = MAX_OFFLINE_MS
		const local = memStore()
		await local.commit([node('local:1')])

		const selected = await sync(local, peer, {
			replica: 'local',
			pull: slot(cursor),
			push: slot(),
			chooseWinner: (localId, remoteId) => [localId, remoteId].sort()[0] as string,
			retries: 0
		}).catch((error: unknown) => error as BootstrapRequiredError)
		expect(selected).toBeInstanceOf(BootstrapRequiredError)
		if (!(selected instanceof BootstrapRequiredError))
			throw new Error('sync did not require bootstrap')
		expect(selected.winnerId).toBe(['local', selected.peerId as string].sort()[0])

		await expect(
			sync(local, peer, {
				replica: 'local',
				pull: slot(cursor),
				push: slot(),
				chooseWinner: () => 'stranger',
				retries: 0
			})
		).rejects.toThrow('winner must be one of the two peer ids')
	})
})
