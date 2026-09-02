/**
 * L01–L06: leased cursor and write-lease behaviour.
 */

import { describe, expect, test } from 'vitest'
import { bootstrap, type CursorSlot, sync, versions } from './engine'
import { BootstrapRequiredError } from './lease'
import { memStore } from './mem'
import { openMemLeased } from './mem-leased'
import { type Node, ROOT } from './store'
import { DEFAULT_SYNC_POLICY, minutes } from './sync-policy'

const file = (over: Partial<Node> & Pick<Node, 'id' | 'name'>): Node => ({
	parent: ROOT,
	type: 'file',
	mode: 0o100644,
	mtimeNs: 0n,
	size: 0n,
	version: 'a:1',
	...over
})

const slot = (start?: string): CursorSlot & { value(): string | undefined } => {
	let cursor = start
	return {
		load: async () => cursor,
		save: async (next) => {
			cursor = next
		},
		value: () => cursor
	}
}

async function scan(
	peer: { since(cursor?: string): Promise<{ nodes: Node[]; next?: string }> },
	from?: string
) {
	const rows: Node[] = []
	let cursor = from
	for (let i = 0; i < 100; i++) {
		const page = await peer.since(cursor)
		expect(page.next).toBeDefined()
		cursor = page.next
		rows.push(...page.nodes)
		if (page.nodes.length === 0) break
	}
	return { rows, cursor: cursor! }
}

async function caughtUp(peer: {
	since(cursor?: string): Promise<{ nodes: Node[]; next?: string }>
}) {
	return scan(peer)
}

describe('L01 signed round trip', () => {
	test('a cursor from since() resumes the same feed', async () => {
		const { local, peer, state } = await openMemLeased()
		await local.commit([file({ id: 'a', name: 'a.txt' })])
		state.feedHead = 2
		const first = await scan(peer)
		const second = await scan(peer)
		expect(second.rows.filter((n) => n.id !== ROOT).map((n) => n.id)).toEqual(
			first.rows.filter((n) => n.id !== ROOT).map((n) => n.id)
		)
		// Resume mid-feed: drain one page, then continue from its cursor.
		let cursor: string | undefined
		const head: Node[] = []
		const page = await peer.since(cursor)
		head.push(...page.nodes)
		cursor = page.next
		const tail = await scan(peer, cursor)
		expect([...head, ...tail.rows].filter((n) => n.id !== ROOT).map((n) => n.id)).toEqual(
			first.rows.filter((n) => n.id !== ROOT).map((n) => n.id)
		)
	})

	test('altering any byte yields bootstrap-required', async () => {
		const { local, peer, state } = await openMemLeased()
		await local.commit([file({ id: 'a', name: 'a.txt' })])
		state.feedHead = 2
		const { cursor } = await caughtUp(peer)
		const tampered = `${cursor.slice(0, -1)}x`
		await expect(peer.since(tampered)).rejects.toBeInstanceOf(BootstrapRequiredError)
		await expect(peer.open(tampered)).rejects.toBeInstanceOf(BootstrapRequiredError)
	})
})

describe('L02 lease before push', () => {
	test('open then commit pushes a row; missing lease writes nothing', async () => {
		const { local, peer, state } = await openMemLeased()
		state.feedHead = 1
		const { cursor } = await caughtUp(peer)
		const lease = await peer.open(cursor)
		const row = file({ id: 'p', name: 'p.txt' })
		await peer.commit(lease, [row])
		expect(await local.child(ROOT, 'p.txt')).toEqual(row)
		expect(await local.child(ROOT, 'q.txt')).toBeNull()
		await expect(peer.commit('bad', [file({ id: 'q', name: 'q.txt' })])).rejects.toBeInstanceOf(
			BootstrapRequiredError
		)
		expect(await local.child(ROOT, 'q.txt')).toBeNull()
	})

	test('the public sync cycle opens a lease before it pushes', async () => {
		const { peer, local: authority } = await openMemLeased()
		const local = memStore()
		const pull = slot(await bootstrap(local, peer))
		const push = slot()
		const mint = versions('client')
		await local.commit([file({ id: 'p', name: 'p.txt', version: mint() })])

		await sync(local, peer, { replica: 'client', pull, push, retries: 0 })

		expect(await authority.child(ROOT, 'p.txt')).toMatchObject({ id: 'p' })
		expect(push.value()).toBeDefined()
	})
})

describe('L03 expiry', () => {
	test('expired cursor is refused at open', async () => {
		const { peer, state, clock } = await openMemLeased()
		state.feedHead = 1
		const page = await peer.since()
		clock.advance(DEFAULT_SYNC_POLICY.cursorLeaseMs + 1)
		await expect(peer.open(page.next)).rejects.toBeInstanceOf(BootstrapRequiredError)
	})

	test('stale preflight refuses before blob transfer or row commit', async () => {
		const held = await openMemLeased()
		const local = memStore()
		const pull = slot(await bootstrap(local, held.peer))
		const push = slot()
		const hash = 'pending-hash'
		await local.blobs.put(hash, new Uint8Array([1]))
		await local.commit([
			file({ id: 'pending', name: 'pending.txt', version: versions('client')(), content: hash })
		])
		held.clock.advance(DEFAULT_SYNC_POLICY.cursorLeaseMs + 1)
		let puts = 0
		let commits = 0
		const peer = {
			...held.peer,
			put: async (...args: Parameters<typeof held.peer.put>) => {
				puts++
				return held.peer.put(...args)
			},
			commit: async (...args: Parameters<typeof held.peer.commit>) => {
				commits++
				return held.peer.commit(...args)
			}
		}

		await expect(
			sync(local, peer, { replica: 'client', pull, push, retries: 0 })
		).rejects.toBeInstanceOf(BootstrapRequiredError)
		expect({ puts, commits, push: push.value() }).toEqual({ puts: 0, commits: 0, push: undefined })
	})
})

describe('L04 renewal', () => {
	test('empty since page renews the cursor past old expiry', async () => {
		const { peer, state, clock } = await openMemLeased()
		state.feedHead = 1
		const first = await peer.since()
		clock.advance(DEFAULT_SYNC_POLICY.cursorLeaseMs - minutes(1))
		const renewed = await peer.since(first.next)
		expect(renewed.nodes).toEqual([])
		clock.advance(minutes(2))
		await expect(peer.open(first.next)).rejects.toBeInstanceOf(BootstrapRequiredError)
		const lease = await peer.open(renewed.next)
		expect(lease).toBeTruthy()
	})
})

describe('L05 mid-transfer expiry', () => {
	test('expired lease refuses later put and commit; first blob stays unreachable', async () => {
		const { local, peer, state, clock } = await openMemLeased()
		state.feedHead = 1
		const { cursor } = await caughtUp(peer)
		const lease = await peer.open(cursor)
		const hash = 'abc'
		await peer.put(lease, hash, new TextEncoder().encode('x'))
		expect(await local.blobs.has(hash)).toBe(true)
		clock.advance(DEFAULT_SYNC_POLICY.writeLeaseMs + 1)
		await expect(peer.put(lease, 'def', new Uint8Array([1]))).rejects.toBeInstanceOf(
			BootstrapRequiredError
		)
		await expect(
			peer.commit(lease, [file({ id: 'b', name: 'b.txt', content: hash })])
		).rejects.toBeInstanceOf(BootstrapRequiredError)
		expect(await local.child(ROOT, 'b.txt')).toBeNull()
	})
})

describe('L06 reset/commit exclusion', () => {
	test('commit runs under the sync lock', async () => {
		const lock = {
			held: false,
			run<T>(fn: () => Promise<T> | T): Promise<T> {
				this.held = true
				return Promise.resolve(fn()).finally(() => {
					this.held = false
				})
			}
		}
		const { local, peer, state } = await openMemLeased({ lock })
		state.feedHead = 1
		const { cursor } = await caughtUp(peer)
		const lease = await peer.open(cursor)
		const commit = peer.commit(lease, [file({ id: 'x', name: 'x.txt' })])
		expect(lock.held).toBe(true)
		await commit
		expect(await local.child(ROOT, 'x.txt')).toBeTruthy()
	})
})

describe('B01 bootstrap is read-only', () => {
	test('a bootstrap page below the floor cannot mint a write lease', async () => {
		const { local, peer, state } = await openMemLeased()
		await local.commit(
			Array.from({ length: 140 }, (_, index) => file({ id: `n${index}`, name: `n${index}.txt` }))
		)
		state.feedFloor = 100
		const first = await peer.since()
		expect(first.nodes.length).toBeGreaterThan(0)
		await expect(peer.open(first.next)).rejects.toBeInstanceOf(BootstrapRequiredError)
		const fresh = memStore()
		const resume = await bootstrap(fresh, peer)
		await expect(peer.open(resume)).resolves.toBeTruthy()
	})

	test('fencing invalidates a lease minted from the old floor', async () => {
		const { local, peer, state } = await openMemLeased()
		const cursor = await bootstrap(memStore(), peer)
		const lease = await peer.open(cursor)
		await local.commit([file({ id: 'later', name: 'later.txt' })])
		state.feedFloor = 2
		await expect(peer.commit(lease, [file({ id: 'old', name: 'old.txt' })])).rejects.toBeInstanceOf(
			BootstrapRequiredError
		)
	})
})

describe('P01 symmetric peers', () => {
	test('each peer expires and bootstraps the other without a replica registry', async () => {
		const a = await openMemLeased()
		const b = await openMemLeased()
		await a.local.commit([file({ id: 'a', name: 'a.txt' })])
		await b.local.commit([file({ id: 'b', name: 'b.txt' })])
		const cursorFromA = await bootstrap(memStore(), a.peer)
		const cursorFromB = await bootstrap(memStore(), b.peer)

		b.clock.advance(DEFAULT_SYNC_POLICY.cursorLeaseMs + 1)
		await expect(b.peer.open(cursorFromB)).rejects.toBeInstanceOf(BootstrapRequiredError)
		await expect(a.peer.open(cursorFromA)).resolves.toBeTruthy()
		a.clock.advance(DEFAULT_SYNC_POLICY.cursorLeaseMs + 1)
		await expect(a.peer.open(cursorFromA)).rejects.toBeInstanceOf(BootstrapRequiredError)

		const freshA = memStore()
		const freshB = memStore()
		await bootstrap(freshA, b.peer)
		await bootstrap(freshB, a.peer)
		expect(await freshA.get('b')).not.toBeNull()
		expect(await freshB.get('a')).not.toBeNull()
	})
})
