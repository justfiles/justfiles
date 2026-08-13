/** Node-addressed sync (protocol v2), replica to replica over memory. */

import { volume } from '@justfiles/fs'
import type { TreePort } from '@justfiles/fs/storage.shared'
import { joinPath } from '@justfiles/fs/storage.shared'
import type { Ino } from '@justfiles/fs/types'
import { FileType } from '@justfiles/fs/types'
import { expect, test, vi } from 'vitest'
import { storageSyncReplica } from './index'
import type { NodeMutation, NodeOperation, NodeState, NodeStore, SyncCapableStorage } from './node'
import { mutationsOf, ROOT_NODE_ID } from './node'
import { NODE_SNAPSHOT_TTL_MS } from './node-snapshot'
import { memNodeStore, nodeMemStorage } from './storage/node-mem'

const REMOTE = 'remote'
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)
const text = (value: Uint8Array): string => new TextDecoder().decode(value)

function optimizedReplica(storage: SyncCapableStorage) {
	const selected = storageSyncReplica(storage)
	if (selected.strategy !== 'incremental') throw new Error('expected incremental sync')
	return selected.replica
}

test('memory exposes optimized sync only through its capability object', () => {
	const storage = nodeMemStorage()

	expect(storage).not.toHaveProperty('nodeSync')
	expect(storage.caps?.sync).toBeDefined()
})

function inoMinter(prefix: string): (() => Ino) & { minted: () => Ino[] } {
	let count = 0
	const mint = () => `${prefix}-${++count}`
	return Object.assign(mint, {
		minted: () => Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`)
	})
}

/**
 * A real memory adapter with disjoint inode spaces. The optional wrapper counts
 * subtree enumeration on both local recording and remote apply.
 */
function makePeer(id: string, opts?: { counting?: boolean; store?: NodeStore }) {
	let enumerated = 0
	const counted = (port: TreePort): TreePort => ({
		...port,
		async enumerateSubtree(ino) {
			enumerated += 1
			return port.enumerateSubtree(ino)
		}
	})
	const mintIno = inoMinter(id)
	const nodes = opts?.store ?? memNodeStore()
	const storage: SyncCapableStorage = nodeMemStorage({
		mintIno,
		store: nodes,
		mapTree: opts?.counting ? counted : undefined
	})
	const replica = optimizedReplica(storage)
	const vol = volume(storage)
	return {
		storage,
		replica,
		vol,
		nodes,
		enumerated: () => enumerated,
		async orphanCount(): Promise<number> {
			const reachable = new Set<Ino>([storage.rootIno])
			async function walk(dir: string): Promise<void> {
				for (const entry of await vol.readdir(dir)) {
					reachable.add(entry.ino)
					if (entry.type === FileType.Directory) await walk(joinPath(dir, entry.name))
				}
			}
			await walk('/')
			let orphans = 0
			for (const ino of mintIno.minted())
				if (!reachable.has(ino) && (await storage.getMeta(ino))) orphans += 1
			return orphans
		},
		async layout(): Promise<string[]> {
			const paths: string[] = []
			async function walk(dir: string): Promise<void> {
				for (const entry of await vol.readdir(dir)) {
					const path = joinPath(dir, entry.name)
					paths.push(path)
					if (entry.type === FileType.Directory) await walk(path)
				}
			}
			await walk('/')
			return paths.sort()
		},
		async nodeAt(path: string): Promise<NodeState | null> {
			const stat = await vol.lstat(path).catch(() => null)
			if (!stat) return null
			const nodeId = await nodes.idFor(stat.ino)
			return nodeId === null ? null : nodes.get(nodeId)
		}
	}
}

type NodePeer = ReturnType<typeof makePeer>

function makeSnapshotPeer(id: string, store?: NodeStore) {
	const mintIno = inoMinter(id)
	const nodes = store ?? memNodeStore()
	const storage = nodeMemStorage({ mintIno, store: nodes })
	const replica = optimizedReplica(storage)
	const vol = volume(storage)
	return {
		storage,
		replica,
		vol,
		nodes,
		async orphanCount(): Promise<number> {
			const reachable = new Set<Ino>([storage.rootIno])
			async function walk(dir: string): Promise<void> {
				for (const entry of await vol.readdir(dir)) {
					reachable.add(entry.ino)
					if (entry.type === FileType.Directory) await walk(joinPath(dir, entry.name))
				}
			}
			await walk('/')
			let orphans = 0
			for (const ino of mintIno.minted())
				if (!reachable.has(ino) && (await storage.getMeta(ino))) orphans += 1
			return orphans
		},
		async layout(): Promise<string[]> {
			const paths: string[] = []
			async function walk(dir: string): Promise<void> {
				for (const entry of await vol.readdir(dir)) {
					const path = joinPath(dir, entry.name)
					paths.push(path)
					if (entry.type === FileType.Directory) await walk(path)
				}
			}
			await walk('/')
			return paths.sort()
		},
		async nodeAt(path: string): Promise<NodeState | null> {
			const stat = await vol.lstat(path).catch(() => null)
			if (!stat) return null
			const nodeId = await nodes.idFor(stat.ino)
			return nodeId === null ? null : nodes.get(nodeId)
		}
	}
}

function withoutContent(storage: SyncCapableStorage): SyncCapableStorage {
	const { content: _content, ...caps } = storage.caps
	return { ...storage, caps }
}

function nodePeers(opts?: { counting?: boolean }) {
	const a = makePeer('a', opts)
	const b = makePeer('b', opts)
	const cursors: Record<string, string> = { ab: '', ba: '' }
	const sent: NodeMutation[] = []
	const echoed: NodeOperation[] = []
	const fetched: string[] = []

	const blobsOf = (source: NodePeer) => async (hash: string) => {
		fetched.push(hash)
		return source.replica.getBlobByHash(hash)
	}

	async function drain(source: NodePeer, target: NodePeer, key: string, limit?: number) {
		let cursor = cursors[key] ?? ''
		let done = false
		let any = false
		while (!done) {
			const result = await source.replica.nodeDeltas(cursor, {
				excludeLocalSource: REMOTE,
				limit
			})
			if (result.operations.length > 0) {
				any = true
				sent.push(...mutationsOf(result.operations))
				if (key === 'ba') echoed.push(...result.operations)
			}
			await target.replica.applyNodeOperations(result.operations, blobsOf(source), {
				source: REMOTE
			})
			cursor = result.to
			done = result.done
		}
		cursors[key] = cursor
		return any
	}

	return {
		a,
		b,
		sent,
		echoed,
		fetched,
		async sync(limit?: number): Promise<void> {
			for (let pass = 0; pass < 10; pass++) {
				const pushed = await drain(a, b, 'ab', limit)
				const pulled = await drain(b, a, 'ba', limit)
				if (!pushed && !pulled) return
			}
		},
		async deliver(times: number): Promise<NodeOperation[]> {
			const result = await a.replica.nodeDeltas('', { limit: 10_000 })
			for (let count = 0; count < times; count++)
				await b.replica.applyNodeOperations(result.operations, blobsOf(a), { source: REMOTE })
			return result.operations
		}
	}
}

test('a create gives both replicas the same node id over independent inodes', async () => {
	const { a, b, sync } = nodePeers()
	await a.vol.mkdir('/docs')
	await a.vol.writeFile('/docs/note.md', bytes('hello'))

	await sync()

	expect(text(await b.vol.readFile('/docs/note.md'))).toBe('hello')
	const docsA = await a.nodeAt('/docs')
	const docsB = await b.nodeAt('/docs')
	const noteA = await a.nodeAt('/docs/note.md')
	const noteB = await b.nodeAt('/docs/note.md')
	expect(docsA?.id).toBeTruthy()
	expect(docsB?.id).toBe(docsA?.id)
	expect(noteA?.id).toBeTruthy()
	expect(noteB?.id).toBe(noteA?.id)
	expect(noteA?.parentId).toBe(docsA?.id)
	expect(noteA?.localIno).not.toBe(noteB?.localIno)
	expect(docsA?.localIno).not.toBe(docsB?.localIno)
	expect((await a.nodeAt('/'))?.id).toBe(ROOT_NODE_ID)
	expect((await b.nodeAt('/'))?.id).toBe(ROOT_NODE_ID)
})

test('a retained journal bootstraps an empty peer one page at a time', async () => {
	const { a, b, sync } = nodePeers()
	await a.vol.mkdir('/old/deep', { recursive: true })
	await a.vol.writeFile('/old/deep/note.txt', bytes('v1'))
	await a.vol.writeFile('/old/deep/note.txt', bytes('v2'))
	await a.vol.rename('/old', '/new')

	await sync(1)

	expect(await b.layout()).toEqual(await a.layout())
	expect(text(await b.vol.readFile('/new/deep/note.txt'))).toBe('v2')
	expect((await b.nodeAt('/new/deep/note.txt'))?.id).toBe(
		(await a.nodeAt('/new/deep/note.txt'))?.id
	)
	expect(await b.orphanCount()).toBe(0)
})

test('a frozen snapshot plus its delta high-water converges after mutations between pages', async () => {
	const a = makeSnapshotPeer('a')
	const b = makeSnapshotPeer('b')
	await a.vol.mkdir('/before/deep', { recursive: true })
	await a.vol.writeFile('/before/deep/a.txt', bytes('a'))
	await a.vol.writeFile('/before/deep/z.txt', bytes('z'))

	let next: string | undefined
	let highWater = ''
	let session = ''
	let pages = 0
	do {
		const page = await a.replica.nodeSnapshot(next, { limit: 1 })
		expect(page.status).toBe('ok')
		if (page.status !== 'ok') throw new Error(page.status)
		highWater = page.syncCursor
		session = page.session
		await b.replica.applyNodeOperations(
			page.operations,
			async (hash) => {
				const blob = await a.replica.getSnapshotBlob(page.session, hash)
				expect(blob.status).toBe('ok')
				if (blob.status !== 'ok') throw new Error(blob.status)
				return blob.data
			},
			{ source: REMOTE }
		)
		next = page.next
		pages++
		if (pages === 1) {
			await a.vol.rename('/before', '/after')
			await a.vol.writeFile('/late.txt', bytes('late'))
		}
	} while (next)
	expect(await a.replica.closeSnapshot(session)).toEqual({ status: 'ok' })

	const delta = await a.replica.nodeDeltas(highWater, { limit: 100 })
	await b.replica.applyNodeOperations(delta.operations, (hash) => a.replica.getBlobByHash(hash), {
		source: REMOTE
	})

	expect(pages).toBeGreaterThan(1)
	expect(await b.layout()).toEqual(await a.layout())
	expect(text(await b.vol.readFile('/after/deep/z.txt'))).toBe('z')
	expect(text(await b.vol.readFile('/late.txt'))).toBe('late')
	for (const path of await a.layout())
		expect((await b.nodeAt(path))?.id).toBe((await a.nodeAt(path))?.id)
	expect(await b.orphanCount()).toBe(0)
})

test('a snapshot token keeps every advertised blob readable across an opening race and GC', async () => {
	const base = memNodeStore()
	let pause = false
	let reached!: () => void
	let resume!: () => void
	const paused = new Promise<void>((resolve) => {
		reached = resolve
	})
	const resumed = new Promise<void>((resolve) => {
		resume = resolve
	})
	const store: NodeStore = {
		...base,
		async head() {
			const head = await base.head()
			if (pause) {
				reached()
				await resumed
			}
			return head
		}
	}
	const a = makeSnapshotPeer('a', store)
	const b = makeSnapshotPeer('b')
	await a.vol.writeFile('/note.txt', bytes('old'))
	const old = await a.nodeAt('/note.txt')
	if (old?.localIno == null || old.contentHash === undefined) throw new Error('missing old node')

	pause = true
	const opening = a.replica.nodeSnapshot(undefined, { limit: 100 })
	await paused
	const updating = a.vol.writeFile('/note.txt', bytes('new'))
	while ((await a.storage.getMeta(old.localIno))?.contentHash === old.contentHash)
		await new Promise((resolve) => setTimeout(resolve, 0))
	const collecting = a.storage.caps?.content?.gcUnreferenced()
	resume()
	const page = await opening
	await updating
	await collecting

	expect(page.status).toBe('ok')
	if (page.status !== 'ok') throw new Error(page.status)
	const retained = await a.replica.getSnapshotBlob(page.session, old.contentHash)
	expect(retained).toEqual({ status: 'ok', data: bytes('old') })
	await b.replica.applyNodeOperations(
		page.operations,
		async (hash) => {
			const blob = await a.replica.getSnapshotBlob(page.session, hash)
			if (blob.status !== 'ok') throw new Error(blob.status)
			return blob.data
		},
		{ source: REMOTE }
	)
	expect(text(await b.vol.readFile('/note.txt'))).toBe('old')

	const delta = await a.replica.nodeDeltas(page.syncCursor, { limit: 100 })
	await b.replica.applyNodeOperations(delta.operations, (hash) => a.replica.getBlobByHash(hash), {
		source: REMOTE
	})
	expect(text(await b.vol.readFile('/note.txt'))).toBe('new')
})

test('sync without content capability eagerly materializes retained snapshot bytes and updates', async () => {
	const sourceBase = nodeMemStorage()
	const targetBase = nodeMemStorage()
	const source = withoutContent(sourceBase)
	const target = withoutContent(targetBase)
	const sourceReplica = optimizedReplica(source)
	const targetReplica = optimizedReplica(target)
	const sourceVolume = volume(source)
	const targetVolume = volume(target)

	await sourceVolume.writeFile('/note.txt', bytes('old'))
	const snapshot = await sourceReplica.nodeSnapshot(undefined, { limit: 100 })
	expect(snapshot.status).toBe('ok')
	if (snapshot.status !== 'ok') throw new Error(snapshot.status)

	await sourceVolume.writeFile('/note.txt', bytes('new'))
	await sourceBase.caps.content?.gcUnreferenced()
	await targetReplica.applyNodeOperations(
		snapshot.operations,
		async (hash) => {
			const blob = await sourceReplica.getSnapshotBlob(snapshot.session, hash)
			if (blob.status !== 'ok') throw new Error(blob.status)
			return blob.data
		},
		{ source: REMOTE }
	)
	expect(text(await targetVolume.readFile('/note.txt'))).toBe('old')
	const oldHash = mutationsOf(snapshot.operations).find(
		(mutation) => mutation.kind === 'create'
	)?.contentHash
	if (!oldHash) throw new Error('missing snapshot content hash')
	expect(await targetReplica.hasBlobByHash(oldHash)).toBe(true)

	const delta = await sourceReplica.nodeDeltas(snapshot.syncCursor)
	await targetReplica.applyNodeOperations(
		delta.operations,
		(hash) => sourceReplica.getBlobByHash(hash),
		{
			source: REMOTE
		}
	)
	expect(text(await targetVolume.readFile('/note.txt'))).toBe('new')
	expect(source.caps.content).toBeUndefined()
	expect(target.caps.content).toBeUndefined()
})

test.each([
	['default', undefined],
	['injected store', memNodeStore()]
] as const)('%s memory adapter retains an unserved snapshot blob', async (_name, store) => {
	const a = makeSnapshotPeer('a', store)
	const b = makeSnapshotPeer('b')
	await a.vol.writeFile('/a.txt', bytes('a'))
	await a.vol.writeFile('/z.txt', bytes('old'))

	const first = await a.replica.nodeSnapshot(undefined, { limit: 1 })
	expect(first.status).toBe('ok')
	if (first.status !== 'ok') throw new Error(first.status)
	await a.vol.writeFile('/z.txt', bytes('new'))
	await a.storage.caps?.content?.gcUnreferenced()

	let page = first
	for (;;) {
		await b.replica.applyNodeOperations(
			page.operations,
			async (hash) => {
				const blob = await a.replica.getSnapshotBlob(page.session, hash)
				if (blob.status !== 'ok') throw new Error(blob.status)
				return blob.data
			},
			{ source: REMOTE }
		)
		if (!page.next) break
		const next = await a.replica.nodeSnapshot(page.next, { limit: 1 })
		expect(next.status).toBe('ok')
		if (next.status !== 'ok') throw new Error(next.status)
		page = next
	}
	expect(await a.replica.closeSnapshot(page.session)).toEqual({ status: 'ok' })

	expect(text(await b.vol.readFile('/z.txt'))).toBe('old')
	const delta = await a.replica.nodeDeltas(first.syncCursor, { limit: 100 })
	await b.replica.applyNodeOperations(delta.operations, (hash) => a.replica.getBlobByHash(hash), {
		source: REMOTE
	})
	expect(text(await b.vol.readFile('/z.txt'))).toBe('new')
})

test('the final snapshot page retains blobs until close and closed tokens restart', async () => {
	const a = makeSnapshotPeer('a')
	await a.vol.writeFile('/a.txt', bytes('a'))
	await a.vol.writeFile('/z.txt', bytes('old'))
	const oldHash = (await a.nodeAt('/z.txt'))?.contentHash
	if (!oldHash) throw new Error('missing old hash')

	const first = await a.replica.nodeSnapshot(undefined, { limit: 1 })
	expect(first.status).toBe('ok')
	if (first.status !== 'ok' || !first.next) throw new Error('missing first page')
	const final = await a.replica.nodeSnapshot(first.next, { limit: 1 })
	expect(final).toMatchObject({ status: 'ok', done: true })
	expect(final).not.toHaveProperty('next')
	if (final.status !== 'ok') throw new Error(final.status)

	await a.vol.writeFile('/z.txt', bytes('new'))
	await a.storage.caps?.content?.gcUnreferenced()
	expect(await a.replica.getSnapshotBlob(final.session, oldHash)).toEqual({
		status: 'ok',
		data: bytes('old')
	})
	expect(await a.replica.closeSnapshot(final.session)).toEqual({ status: 'ok' })
	expect(await a.replica.getSnapshotBlob(final.session, oldHash)).toEqual({ status: 'restart' })
	expect(await a.replica.nodeSnapshot(first.next, { limit: 1 })).toEqual({ status: 'restart' })
	expect(await a.replica.closeSnapshot('unknown')).toEqual({ status: 'restart' })
})

test('an abandoned snapshot expires to the same restart result', async () => {
	vi.useFakeTimers()
	try {
		const a = makeSnapshotPeer('a')
		await a.vol.writeFile('/a.txt', bytes('old'))
		await a.vol.writeFile('/z.txt', bytes('later'))
		const hash = (await a.nodeAt('/a.txt'))?.contentHash
		if (!hash) throw new Error('missing hash')
		const page = await a.replica.nodeSnapshot(undefined, { limit: 1 })
		if (page.status !== 'ok') throw new Error(page.status)

		await vi.advanceTimersByTimeAsync(NODE_SNAPSHOT_TTL_MS + 1)

		expect(await a.replica.getSnapshotBlob(page.session, hash)).toEqual({ status: 'restart' })
		expect(await a.replica.closeSnapshot(page.session)).toEqual({ status: 'restart' })
		if (!page.next) throw new Error('missing next page')
		expect(await a.replica.nodeSnapshot(page.next, { limit: 1 })).toEqual({
			status: 'restart'
		})
	} finally {
		vi.useRealTimers()
	}
})

test('the memory session bound rejects excess opens without evicting live tokens', async () => {
	const a = makeSnapshotPeer('a')
	const admitted = []
	for (let index = 0; index < 4; index++) {
		const page = await a.replica.nodeSnapshot(undefined, { limit: 1 })
		expect(page.status).toBe('ok')
		if (page.status !== 'ok') throw new Error(page.status)
		admitted.push(page)
	}

	expect(await a.replica.nodeSnapshot(undefined, { limit: 1 })).toEqual({ status: 'busy' })
	for (const page of admitted) {
		expect(await a.replica.closeSnapshot(page.session)).toEqual({ status: 'ok' })
	}
	expect((await a.replica.nodeSnapshot(undefined, { limit: 1 })).status).toBe('ok')
})

test('a non-positive snapshot page limit is rejected without admitting a session', async () => {
	const a = makeSnapshotPeer('a')
	await a.vol.writeFile('/note.txt', bytes('note'))

	for (let attempt = 0; attempt < 4; attempt++)
		await expect(a.replica.nodeSnapshot(undefined, { limit: 0 })).rejects.toThrow(RangeError)

	expect((await a.replica.nodeSnapshot(undefined, { limit: 1 })).status).toBe('ok')
})

test('a retained journal preserves a moved child after its old parent is deleted', async () => {
	const { a, b, sync } = nodePeers()
	await a.vol.mkdir('/old')
	await a.vol.writeFile('/old/f.txt', bytes('kept'))
	await a.vol.mkdir('/new')
	await a.vol.rename('/old/f.txt', '/new/f.txt')
	await a.vol.rm('/old')

	await sync(1)

	expect(await b.layout()).toEqual(await a.layout())
	expect(text(await b.vol.readFile('/new/f.txt'))).toBe('kept')
	expect((await b.nodeAt('/new/f.txt'))?.id).toBe((await a.nodeAt('/new/f.txt'))?.id)
	expect(await b.orphanCount()).toBe(0)
})

test('a rename of a populated directory is one move and preserves descendant state', async () => {
	const { a, b, sent, echoed, sync } = nodePeers()
	await a.vol.mkdir('/old/deep', { recursive: true })
	await a.vol.writeFile('/old/one.txt', bytes('1'))
	await a.vol.writeFile('/old/deep/two.txt', bytes('2'))
	await sync()
	const descendant = await a.nodeAt('/old/deep/two.txt')
	sent.length = 0

	await a.vol.rename('/old', '/new')
	await sync()

	expect(sent).toHaveLength(1)
	expect(sent[0]).toMatchObject({ kind: 'move', name: 'new' })
	expect(echoed).toEqual([])
	expect(await b.vol.exists('/old')).toBe(false)
	expect(text(await b.vol.readFile('/new/deep/two.txt'))).toBe('2')
	expect(text(await b.vol.readFile('/new/one.txt'))).toBe('1')
	expect(await b.nodeAt('/new/deep/two.txt')).toMatchObject({
		id: descendant?.id,
		revision: descendant?.revision,
		contentHash: descendant?.contentHash
	})
})

test('a 4,000-descendant move is one row, one mutation, no bytes, no enumeration', async () => {
	const { a, b, sent, fetched, sync } = nodePeers({ counting: true })
	await a.vol.mkdir('/src/tree', { recursive: true })
	await a.vol.mkdir('/dst', { recursive: true })
	for (let index = 0; index < 4000; index++)
		await a.vol.writeFile(`/src/tree/f${index}.txt`, bytes(String(index)))
	await sync()
	const head = await a.nodes.head()
	sent.length = 0
	fetched.length = 0

	await a.vol.rename('/src/tree', '/dst/tree')
	expect(await a.nodes.head()).toBe(head + 1)
	await sync()

	expect(sent).toHaveLength(1)
	expect(sent[0]).toMatchObject({ kind: 'move', name: 'tree' })
	expect(fetched).toEqual([])
	expect(a.enumerated() + b.enumerated()).toBe(0)
	expect(text(await b.vol.readFile('/dst/tree/f3999.txt'))).toBe('3999')
	expect(await b.vol.exists('/src/tree')).toBe(false)
})

test('an edit arrives under the same node id and location', async () => {
	const { a, b, sent, sync } = nodePeers()
	await a.vol.mkdir('/docs')
	await a.vol.writeFile('/docs/note.md', bytes('v1'))
	await sync()
	const before = await b.nodeAt('/docs/note.md')
	sent.length = 0

	await a.vol.writeFile('/docs/note.md', bytes('v2 is longer'))
	await sync()

	expect(sent.map((mutation) => mutation.kind)).toEqual(['update'])
	const after = await b.nodeAt('/docs/note.md')
	expect(after?.id).toBe(before?.id)
	expect(after?.parentId).toBe(before?.parentId)
	expect(after?.name).toBe('note.md')
	expect(after?.revision).toBeGreaterThan(before?.revision ?? 0)
	expect(text(await b.vol.readFile('/docs/note.md'))).toBe('v2 is longer')
	expect((await b.vol.stat('/docs/note.md')).size).toBe((await a.vol.stat('/docs/note.md')).size)
})

test('a lagging peer skips superseded update blobs after source GC', async () => {
	const { a, b, fetched, sync } = nodePeers()
	await a.vol.writeFile('/note.txt', bytes('v1'))
	await sync()

	await a.vol.writeFile('/note.txt', bytes('v2'))
	const staleHash = (await a.nodeAt('/note.txt'))?.contentHash
	await a.vol.writeFile('/note.txt', bytes('v3'))
	await a.storage.caps?.content?.gcUnreferenced()
	fetched.length = 0

	await sync(1)

	expect(text(await b.vol.readFile('/note.txt'))).toBe('v3')
	expect(fetched).not.toContain(staleHash)
})

test('a first sync skips a create blob superseded by offline edits', async () => {
	const { a, b, deliver, fetched } = nodePeers()
	await a.vol.writeFile('/note.txt', bytes('v1'))
	const staleHash = (await a.nodeAt('/note.txt'))?.contentHash
	await a.vol.writeFile('/note.txt', bytes('v2'))
	await a.vol.writeFile('/note.txt', bytes('v3'))
	await a.storage.caps?.content?.gcUnreferenced()

	await deliver(1)

	expect(text(await b.vol.readFile('/note.txt'))).toBe('v3')
	expect(fetched).not.toContain(staleHash)
})

test('a first sync skips content deleted before delivery', async () => {
	const { a, b, deliver, fetched } = nodePeers()
	await a.vol.writeFile('/note.txt', bytes('obsolete'))
	const staleHash = (await a.nodeAt('/note.txt'))?.contentHash
	await a.vol.rm('/note.txt')
	await a.storage.caps?.content?.gcUnreferenced()

	await deliver(1)

	expect(await b.vol.exists('/note.txt')).toBe(false)
	expect(fetched).not.toContain(staleHash)
})

test('a delete tombstones its id and a recreated path gets a new one', async () => {
	const { a, b, sync } = nodePeers()
	await a.vol.mkdir('/docs')
	await a.vol.writeFile('/docs/note.md', bytes('one'))
	await sync()
	const oldId = (await a.nodeAt('/docs/note.md'))?.id ?? ''

	await a.vol.rm('/docs/note.md')
	await sync()

	expect(await b.vol.exists('/docs/note.md')).toBe(false)
	expect(await a.nodes.get(oldId)).toMatchObject({ deleted: true, localIno: null })
	expect(await b.nodes.get(oldId)).toMatchObject({ deleted: true, localIno: null })

	await a.vol.writeFile('/docs/note.md', bytes('two'))
	await sync()

	const newA = await a.nodeAt('/docs/note.md')
	const newB = await b.nodeAt('/docs/note.md')
	expect(newB?.id).toBe(newA?.id)
	expect(newA?.id).not.toBe(oldId)
	expect(text(await b.vol.readFile('/docs/note.md'))).toBe('two')
	expect(await b.nodes.get(oldId)).toMatchObject({ deleted: true })
})

test('a recursive delete is ordered child before parent', async () => {
	const { a, b, sent, sync } = nodePeers()
	await a.vol.mkdir('/tree/sub', { recursive: true })
	await a.vol.writeFile('/tree/sub/f.txt', bytes('x'))
	await sync()
	const ids = [
		(await a.nodeAt('/tree/sub/f.txt'))?.id,
		(await a.nodeAt('/tree/sub'))?.id,
		(await a.nodeAt('/tree'))?.id
	]
	sent.length = 0

	await a.vol.rm('/tree', { recursive: true })
	await sync()

	expect(sent.map((mutation) => mutation.kind)).toEqual(['delete', 'delete', 'delete'])
	expect(sent.map((mutation) => mutation.nodeId)).toEqual(ids)
	expect(await b.vol.exists('/tree')).toBe(false)
})

test('a rename over a live file tombstones the displaced identity', async () => {
	const { a, b, sync } = nodePeers()
	await a.vol.writeFile('/keep.txt', bytes('keep'))
	await a.vol.writeFile('/gone.txt', bytes('gone'))
	await sync()
	const displaced = (await a.nodeAt('/gone.txt'))?.id ?? ''
	const moved = (await a.nodeAt('/keep.txt'))?.id

	await a.vol.rename('/keep.txt', '/gone.txt')
	await sync()

	expect(await a.nodes.get(displaced)).toMatchObject({ deleted: true, localIno: null })
	expect(await b.nodes.get(displaced)).toMatchObject({ deleted: true, localIno: null })
	expect((await b.nodeAt('/gone.txt'))?.id).toBe(moved)
	expect(text(await b.vol.readFile('/gone.txt'))).toBe('keep')
	expect(await b.vol.exists('/keep.txt')).toBe(false)
})

test('re-delivering accepted create, update, move and delete mutations is idempotent', async () => {
	const { a, b, deliver } = nodePeers()
	await a.vol.mkdir('/dir')
	await a.vol.mkdir('/other')
	await a.vol.writeFile('/dir/f.txt', bytes('one'))
	await a.vol.writeFile('/dir/f.txt', bytes('two'))
	await a.vol.rename('/dir/f.txt', '/other/f.txt')
	await a.vol.writeFile('/dir/tmp.txt', bytes('tmp'))
	await a.vol.rm('/dir/tmp.txt')

	const operations = await deliver(1)
	const settled = await b.nodeAt('/other/f.txt')
	await b.replica.applyNodeOperations(
		operations,
		() => Promise.reject(new Error('stale retry fetched content')),
		{ source: REMOTE }
	)
	await deliver(1)

	expect(await b.nodeAt('/other/f.txt')).toEqual(settled)
	expect((await b.nodeAt('/other/f.txt'))?.id).toBe((await a.nodeAt('/other/f.txt'))?.id)
	expect(text(await b.vol.readFile('/other/f.txt'))).toBe('two')
	expect(await b.vol.exists('/dir/f.txt')).toBe(false)
	expect(await b.vol.exists('/dir/tmp.txt')).toBe(false)
	expect(await b.orphanCount()).toBe(0)
	expect((await b.vol.readdir('/other')).map((entry) => entry.name)).toEqual(['f.txt'])
})

test('a stale content mutation fetches no bytes and changes nothing', async () => {
	const a = makePeer('a')
	const b = makePeer('b')
	await a.vol.writeFile('/note.txt', bytes('old'))
	const create = await a.replica.nodeDeltas('', { limit: 100 })
	await b.replica.applyNodeOperations(create.operations, (hash) => a.replica.getBlobByHash(hash))

	await a.vol.writeFile('/note.txt', bytes('new'))
	const update = await a.replica.nodeDeltas(create.to, { limit: 100 })
	await b.replica.applyNodeOperations(update.operations, (hash) => a.replica.getBlobByHash(hash))
	await b.storage.caps?.content?.gcUnreferenced()

	await b.replica.applyNodeOperations(create.operations, () =>
		Promise.reject(new Error('stale mutation fetched content'))
	)

	expect(text(await b.vol.readFile('/note.txt'))).toBe('new')
	const nodeA = await a.nodeAt('/note.txt')
	const nodeB = await b.nodeAt('/note.txt')
	expect(nodeB).toMatchObject({
		id: nodeA?.id,
		parentId: nodeA?.parentId,
		name: nodeA?.name,
		revision: nodeA?.revision,
		contentHash: nodeA?.contentHash
	})
	expect(nodeB?.localIno).not.toBe(nodeA?.localIno)
})

test('a stale received update cannot replace retained journal state', async () => {
	const a = makePeer('a')
	const c = makePeer('c')
	await a.vol.writeFile('/note.txt', bytes('v1'))
	const create = await a.replica.nodeDeltas('', { limit: 100 })
	await a.vol.writeFile('/note.txt', bytes('v2'))
	const stale = await a.replica.nodeDeltas(create.to, { limit: 100 })
	await a.vol.writeFile('/note.txt', bytes('v3'))

	await a.replica.applyNodeOperations(
		stale.operations,
		() => Promise.reject(new Error('stale mutation fetched content')),
		{ source: REMOTE }
	)
	await a.storage.caps?.content?.gcUnreferenced()
	const retained = await a.replica.nodeDeltas('', { limit: 100 })
	await c.replica.applyNodeOperations(retained.operations, (hash) => a.replica.getBlobByHash(hash))

	expect(text(await c.vol.readFile('/note.txt'))).toBe('v3')
})
