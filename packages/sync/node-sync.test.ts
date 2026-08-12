/** Node-addressed sync (protocol v2), replica to replica over memory. */

import { volume } from '@justfiles/fs'
import { memStorage } from '@justfiles/fs/storage/mem'
import type { TreePort } from '@justfiles/fs/storage.shared'
import { joinPath } from '@justfiles/fs/storage.shared'
import type { Ino } from '@justfiles/fs/types'
import { FileType } from '@justfiles/fs/types'
import { expect, test } from 'vitest'
import type { NodeMutation, NodeOperation, NodeState, NodeStorage, NodeStore } from './node'
import { mutationsOf, nodeSyncReplica, ROOT_NODE_ID } from './node'
import { memNodeStore, nodeMemStorage, nodeSyncExtension } from './storage/node-mem'

const REMOTE = 'remote'
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)
const text = (value: Uint8Array): string => new TextDecoder().decode(value)

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
	let storage: NodeStorage
	if (opts?.counting) {
		const extension = nodeSyncExtension(opts.store ?? memNodeStore())
		storage = memStorage({
			mintIno,
			extension: {
				observer: {
					record: (port, effect, options) =>
						extension.observer.record(counted(port), effect, options)
				},
				attach: (tree) => extension.attach(counted(tree))
			}
		})
	} else if (opts?.store) {
		storage = memStorage({ mintIno, extension: nodeSyncExtension(opts.store) })
	} else {
		storage = nodeMemStorage({ mintIno })
	}
	const replica = nodeSyncReplica(storage, storage.nodeSync)
	const vol = volume(storage)
	const nodes = storage.nodeSync.nodes
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
		},
		async bootstrap(
			limit?: number,
			inspect?: (operations: NodeOperation[], page: number) => Promise<void>
		): Promise<string[]> {
			let page: string | undefined
			let cursor = ''
			const highWaters: string[] = []
			do {
				const result = await a.replica.nodeScan(page, { limit })
				cursor = result.syncCursor
				highWaters.push(cursor)
				sent.push(...mutationsOf(result.operations))
				if (inspect) await inspect(result.operations, highWaters.length)
				await b.replica.applyNodeOperations(result.operations, blobsOf(a), { source: REMOTE })
				page = result.done ? undefined : result.next
			} while (page)
			cursors.ab = cursor
			return highWaters
		}
	}
}

test('a create gives both replicas the same node id over independent inodes', async () => {
	const { a, b, bootstrap } = nodePeers()
	await a.vol.mkdir('/docs')
	await a.vol.writeFile('/docs/note.md', bytes('hello'))

	await bootstrap()

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

test('a phase-1 snapshot create cannot overwrite a known node', async () => {
	const a = makePeer('a')
	const b = makePeer('b')
	await a.vol.writeFile('/note.txt', bytes('v1'))
	const create = await a.replica.nodeDeltas('', { limit: 100 })
	await b.replica.applyNodeOperations(create.operations, (hash) => a.replica.getBlobByHash(hash))
	await a.vol.writeFile('/note.txt', bytes('v2'))
	const snapshot = await a.replica.nodeScan(undefined, { limit: 100 })
	await b.replica.applyNodeOperations(snapshot.operations, () =>
		Promise.reject(new Error('known snapshot create fetched content'))
	)

	expect(text(await b.vol.readFile('/note.txt'))).toBe('v1')
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

test('a paged bootstrap applies parents before children and loses no delta', async () => {
	const { a, b, bootstrap, sync } = nodePeers()
	const leaves: string[] = []
	for (let index = 0; index < 4; index++) {
		let path = ''
		for (let depth = 0; depth < 4; depth++) path += `/d${index}x${depth}`
		await a.vol.mkdir(path, { recursive: true })
		await a.vol.writeFile(`${path}/leaf.txt`, bytes(`leaf ${index}`))
		leaves.push(`${path}/leaf.txt`)
	}

	const known = new Set<string>([ROOT_NODE_ID])
	const highWaters = await bootstrap(3, async (operations, page) => {
		for (const mutation of mutationsOf(operations)) {
			expect(mutation.kind).toBe('create')
			if (mutation.kind !== 'create') continue
			expect(known.has(mutation.parentId)).toBe(true)
			known.add(mutation.nodeId)
		}
		if (page === 1) await a.vol.writeFile('/aaa-late.txt', bytes('late'))
	})

	expect(highWaters.length).toBeGreaterThan(3)
	expect(new Set(highWaters).size).toBe(1)
	for (const [index, leaf] of leaves.entries())
		expect(text(await b.vol.readFile(leaf))).toBe(`leaf ${index}`)
	expect(await b.orphanCount()).toBe(0)
	expect(await b.vol.exists('/aaa-late.txt')).toBe(false)

	await sync()
	expect(text(await b.vol.readFile('/aaa-late.txt'))).toBe('late')
	expect((await b.nodeAt('/aaa-late.txt'))?.id).toBe((await a.nodeAt('/aaa-late.txt'))?.id)
})

test('a paged bootstrap retains frozen content through source GC', async () => {
	const { a, b, bootstrap, sync } = nodePeers()
	await a.vol.writeFile('/a.txt', bytes('first'))
	await a.vol.writeFile('/z.txt', bytes('old'))
	const frozenHash = (await a.nodeAt('/z.txt'))?.contentHash ?? ''

	await bootstrap(1, async (_operations, page) => {
		if (page !== 1) return
		await a.vol.writeFile('/z.txt', bytes('new'))
		await a.storage.caps?.content?.gcUnreferenced()
		expect(await a.replica.hasBlobByHash(frozenHash)).toBe(true)
	})

	expect(text(await b.vol.readFile('/z.txt'))).toBe('old')
	await sync()
	expect(text(await b.vol.readFile('/z.txt'))).toBe('new')
})

test('a rename during a paged bootstrap cannot drop a node', async () => {
	const { a, b, bootstrap, sync } = nodePeers()
	await a.vol.writeFile('/m.txt', bytes('m'))
	await a.vol.writeFile('/z.txt', bytes('z'))

	await bootstrap(1, async (_operations, page) => {
		if (page === 1) await a.vol.rename('/z.txt', '/a.txt')
	})
	await sync()

	expect(text(await b.vol.readFile('/a.txt'))).toBe('z')
	expect(text(await b.vol.readFile('/m.txt'))).toBe('m')
	expect(await b.vol.exists('/z.txt')).toBe(false)
	expect((await b.nodeAt('/a.txt'))?.id).toBe((await a.nodeAt('/a.txt'))?.id)
})

test('a mutation during snapshot construction cannot strand a node', async () => {
	const base = memNodeStore()
	let fire: (() => Promise<void>) | null = null
	let firing = false
	const after = async (): Promise<void> => {
		if (!fire || firing) return
		firing = true
		await fire()
		firing = false
	}
	const store: NodeStore = {
		...base,
		async live() {
			const nodes = await base.live()
			await after()
			return nodes
		}
	}
	const a = makePeer('a', { store })
	const b = makePeer('b')
	await a.vol.mkdir('/a')
	await a.vol.mkdir('/b')
	const names = ['1.txt', '2.txt', '3.txt', '4.txt']
	for (const name of names) await a.vol.writeFile(`/b/${name}`, bytes(name))
	const queued = [...names]
	fire = async () => {
		const name = queued.shift()
		if (name) await a.vol.rename(`/b/${name}`, `/a/${name}`)
	}

	const scan = await a.replica.nodeScan(undefined, { limit: 1000 })
	fire = null
	await b.replica.applyNodeOperations(scan.operations, (hash) => a.replica.getBlobByHash(hash), {
		source: REMOTE
	})
	const delta = await a.replica.nodeDeltas(scan.syncCursor, { limit: 1000 })
	await b.replica.applyNodeOperations(delta.operations, (hash) => a.replica.getBlobByHash(hash), {
		source: REMOTE
	})

	expect(queued.length).toBeLessThan(names.length)
	expect(await b.layout()).toEqual(await a.layout())
	for (const path of await a.layout())
		expect((await b.nodeAt(path))?.id).toBe((await a.nodeAt(path))?.id)
})
