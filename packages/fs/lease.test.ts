/**
 * L01–L06: leased cursor and write-lease behaviour.
 */

import { describe, expect, test } from 'vitest'
import { BootstrapRequiredError } from './lease'
import { openMemLeased } from './mem-leased'
import { DEFAULT_SYNC_POLICY, minutes } from './sync-policy'
import { ROOT, type Node } from './store'

const file = (over: Partial<Node> & Pick<Node, 'id' | 'name'>): Node => ({
	parent: ROOT,
	type: 'file',
	mode: 0o100644,
	mtimeNs: 0n,
	size: 0n,
	version: 'a:1',
	...over
})

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

async function caughtUp(peer: { since(cursor?: string): Promise<{ nodes: Node[]; next?: string }> }) {
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
})

describe('L03 expiry', () => {
	test('expired cursor is refused at open', async () => {
		const { peer, state, clock } = await openMemLeased()
		state.feedHead = 1
		const page = await peer.since()
		clock.advance(DEFAULT_SYNC_POLICY.cursorLeaseMs + 1)
		await expect(peer.open(page.next)).rejects.toBeInstanceOf(BootstrapRequiredError)
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
