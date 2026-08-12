/**
 * Node-addressed sync (protocol v2), replica to replica over memory.
 *
 * Every test drives the PUBLIC v2 surface — `nodeSyncReplica` (deltas / scan /
 * apply / blobs) and the node store's identity lookup — never a private helper.
 * The two peers mint their inodes from disjoint spaces (`a-1…` vs `b-1…`), so an
 * assertion can never accidentally pass because a sync ID happened to equal a
 * local inode.
 */

import { volume } from '@justfiles/fs'
import { memStorage } from '@justfiles/fs/storage/mem'
import type { TreePort } from '@justfiles/fs/storage.shared'
import { joinPath } from '@justfiles/fs/storage.shared'
import type { Ino } from '@justfiles/fs/types'
import { FileType } from '@justfiles/fs/types'
import { expect, test } from 'vitest'
import type { NodeMutation, NodeOperation, NodeState, NodeStorage } from './node'
import { mutationsOf, nodeSyncReplica, ProjectionCursorError, ROOT_NODE_ID } from './node'
import { memNodeStore, nodeMemStorage, nodeSyncExtension } from './storage/node-mem'

/** Local apply tag: rows the sync layer wrote are never pushed back. */
const REMOTE = 'remote'

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)
const text = (b: Uint8Array): string => new TextDecoder().decode(b)

/**
 * Disjoint, human-readable inode spaces so the two replicas can never collide —
 * and so a test can enumerate every inode this replica ever minted, which is what
 * makes the orphan check exact.
 */
function inoMinter(prefix: string): (() => Ino) & { minted: () => Ino[] } {
	let n = 0
	const mint = () => `${prefix}-${++n}`
	return Object.assign(mint, {
		minted: () => Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`)
	})
}

/**
 * A peer over the real memory adapter. `counting` composes the SAME production
 * extension over a `memStorage` whose `TreePort` counts `enumerateSubtree` calls,
 * in both the recorder (the port handed to `observer.record`) and the applier (the
 * port handed to `attach`) — the O(1)-move guarantee, checked rather than assumed.
 */
function makePeer(id: string, opts?: { counting?: boolean; ignore?: readonly string[] }) {
	let enumerated = 0
	const counted = (port: TreePort): TreePort => ({
		...port,
		enumerateSubtree(ino) {
			enumerated += 1
			return port.enumerateSubtree(ino)
		}
	})
	const mintIno = inoMinter(id)
	let storage: NodeStorage
	if (opts?.counting) {
		const base = nodeSyncExtension(memNodeStore(), opts.ignore)
		storage = memStorage({
			mintIno,
			extension: {
				observer: { record: (port, effect, o) => base.observer.record(counted(port), effect, o) },
				attach: (tree) => base.attach(counted(tree))
			}
		})
	} else {
		storage = nodeMemStorage({ mintIno, ignore: opts?.ignore })
	}
	const replica = nodeSyncReplica(storage, storage.nodeSync)
	const vol = volume(storage)
	const nodes = storage.nodeSync.nodes
	return {
		id,
		storage,
		replica,
		vol,
		nodes,
		/** How often this replica walked a subtree. */
		enumerated: () => enumerated,
		/**
		 * Inodes this replica minted that hold metadata but no name — the classic
		 * failure of an apply that mints a second inode for a node it already has.
		 */
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
		/** The sync node bound to whatever this replica has at `path` (null if none). */
		async nodeAt(path: string): Promise<NodeState | null> {
			const st = await vol.lstat(path).catch(() => null)
			if (!st) return null
			const nodeId = await nodes.idFor(st.ino)
			return nodeId === null ? null : nodes.get(nodeId)
		}
	}
}

type NodePeer = ReturnType<typeof makePeer>

/** Two replicas plus a pump that drives the real v2 methods (no timer). */
function nodePeers(opts?: {
	counting?: boolean
	ignore?: readonly string[]
	aIgnore?: readonly string[]
	bIgnore?: readonly string[]
}) {
	const a = makePeer('a', { counting: opts?.counting, ignore: opts?.aIgnore ?? opts?.ignore })
	const b = makePeer('b', { counting: opts?.counting, ignore: opts?.bIgnore ?? opts?.ignore })
	const cursors: Record<string, string> = { ab: '', ba: '' }
	const sent: NodeMutation[] = []
	const sentOps: NodeOperation[] = []
	const echoed: NodeOperation[] = []
	const fetched: string[] = []

	const blobsOf = (source: NodePeer) => async (hash: string) => {
		fetched.push(hash)
		return source.replica.getBlobByHash(hash)
	}

	async function drain(
		source: NodePeer,
		target: NodePeer,
		key: string,
		limit?: number
	): Promise<boolean> {
		let cursor = cursors[key] ?? ''
		let done = false
		let any = false
		while (!done) {
			const res = await source.replica.nodeDeltas(cursor, { excludeLocalSource: REMOTE, limit })
			if (res.operations.length > 0) {
				any = true
				sent.push(...mutationsOf(res.operations))
				sentOps.push(...res.operations)
				if (key === 'ba') echoed.push(...res.operations)
			}
			await target.replica.applyNodeOperations(res.operations, blobsOf(source), { source: REMOTE })
			cursor = res.to
			done = res.done
		}
		cursors[key] = cursor
		return any
	}

	return {
		a,
		b,
		/** Mutations that crossed the wire in either direction. */
		sent,
		/** The same traffic, keeping each atomic operation intact. */
		sentOps,
		/** Only what B sent BACK — an apply that echoes is a loop. */
		echoed,
		/** Content hashes the receiver asked the sender for. */
		fetched,
		async sync(limit?: number): Promise<void> {
			for (let pass = 0; pass < 10; pass++) {
				const pushed = await drain(a, b, 'ab', limit)
				const pulled = await drain(b, a, 'ba', limit)
				if (!pushed && !pulled) return
			}
		},
		/**
		 * Deliver A's whole delta stream to B `times` times — a transport that
		 * retried after an ambiguous failure.
		 */
		async deliver(times: number): Promise<NodeOperation[]> {
			const res = await a.replica.nodeDeltas('', { limit: 10_000 })
			for (let i = 0; i < times; i++)
				await b.replica.applyNodeOperations(res.operations, blobsOf(a), { source: REMOTE })
			return res.operations
		},
		/**
		 * Page A's full node snapshot into B and resume deltas at the frozen cursor.
		 * `inspect` sees each page BEFORE it is applied.
		 */
		async bootstrap(
			limit?: number,
			inspect?: (operations: NodeOperation[], page: number) => Promise<void>
		): Promise<string[]> {
			let page: string | undefined
			let cursor = ''
			const pages: string[] = []
			do {
				const res = await a.replica.nodeScan(page, { limit })
				cursor = res.syncCursor
				pages.push(res.syncCursor)
				sent.push(...mutationsOf(res.operations))
				if (inspect) await inspect(res.operations, pages.length)
				await b.replica.applyNodeOperations(res.operations, blobsOf(a), { source: REMOTE })
				page = res.done ? undefined : res.next
			} while (page)
			cursors.ab = cursor
			return pages
		}
	}
}

// ── Cycle 1: shared identity on create ────────────────────────────────────────

test('a create gives both replicas the same node id over independent inodes', async () => {
	const { a, b, bootstrap } = nodePeers()
	await a.vol.mkdir('/docs')
	await a.vol.writeFile('/docs/note.md', bytes('hello'))

	await bootstrap()

	expect(text(await b.vol.readFile('/docs/note.md'))).toBe('hello')

	const docsA = await a.nodeAt('/docs')
	const docsB = await b.nodeAt('/docs')
	expect(docsA?.id).toBeTruthy()
	expect(docsB?.id).toBe(docsA?.id)

	const noteA = await a.nodeAt('/docs/note.md')
	const noteB = await b.nodeAt('/docs/note.md')
	expect(noteA?.id).toBeTruthy()
	expect(noteB?.id).toBe(noteA?.id)
	expect(noteA?.parentId).toBe(docsA?.id)

	// Identity is shared; the inode binding behind it is each replica's own.
	expect(noteA?.localIno).not.toBe(noteB?.localIno)
	expect(docsA?.localIno).not.toBe(docsB?.localIno)

	// The root is well-known on both, bound to each replica's own root inode.
	expect((await a.nodeAt('/'))?.id).toBe(ROOT_NODE_ID)
	expect((await b.nodeAt('/'))?.id).toBe(ROOT_NODE_ID)
})

// ── Cycle 2: one move mutation ────────────────────────────────────────────────

test('a rename of a populated directory is ONE move mutation', async () => {
	const { a, b, sent, sync } = nodePeers()
	await a.vol.mkdir('/old/deep', { recursive: true })
	await a.vol.writeFile('/old/one.txt', bytes('1'))
	await a.vol.writeFile('/old/deep/two.txt', bytes('2'))
	await sync()
	const deepId = (await a.nodeAt('/old/deep/two.txt'))?.id
	sent.length = 0

	await a.vol.rename('/old', '/new')
	await sync()

	expect(sent).toHaveLength(1)
	expect(sent[0]).toMatchObject({ kind: 'move', name: 'new' })

	expect(await b.vol.exists('/old')).toBe(false)
	expect(text(await b.vol.readFile('/new/deep/two.txt'))).toBe('2')
	expect(text(await b.vol.readFile('/new/one.txt'))).toBe('1')
	// The descendants moved with the entry: same identity, new location.
	expect((await b.nodeAt('/new/deep/two.txt'))?.id).toBe(deepId)
})

// ── Cycle 3: cost is independent of subtree size ──────────────────────────────

test('a 4,000-descendant move is one row, one mutation, no bytes, no enumeration', async () => {
	const { a, b, sent, fetched, sync } = nodePeers({ counting: true })
	await a.vol.mkdir('/src/tree', { recursive: true })
	await a.vol.mkdir('/dst', { recursive: true })
	for (let i = 0; i < 4000; i++) await a.vol.writeFile(`/src/tree/f${i}.txt`, bytes(String(i)))
	await sync()
	const head = await a.nodes.head()
	sent.length = 0
	fetched.length = 0

	await a.vol.rename('/src/tree', '/dst/tree')

	// One durable node mutation on the source, whatever the subtree holds.
	expect(await a.nodes.head()).toBe(head + 1)

	await sync()

	expect(sent).toHaveLength(1)
	expect(sent[0]).toMatchObject({ kind: 'move', name: 'tree' })
	// A move re-uploads nothing: content is hash-addressed and did not change.
	expect(fetched).toEqual([])
	expect(a.enumerated() + b.enumerated()).toBe(0)

	expect(text(await b.vol.readFile('/dst/tree/f3999.txt'))).toBe('3999')
	expect(await b.vol.exists('/src/tree')).toBe(false)
})

// ── Cycle 4: update keeps identity ────────────────────────────────────────────

test('an edit arrives under the same node id and location', async () => {
	const { a, b, sent, sync } = nodePeers()
	await a.vol.mkdir('/docs')
	await a.vol.writeFile('/docs/note.md', bytes('v1'))
	await sync()
	const before = await b.nodeAt('/docs/note.md')
	sent.length = 0

	await a.vol.writeFile('/docs/note.md', bytes('v2 is longer'))
	await sync()

	expect(sent.map((m) => m.kind)).toEqual(['update'])
	const after = await b.nodeAt('/docs/note.md')
	expect(after?.id).toBe(before?.id)
	expect(after?.parentId).toBe(before?.parentId)
	expect(after?.name).toBe('note.md')
	expect(after?.revision).toBeGreaterThan(before?.revision ?? 0)

	expect(text(await b.vol.readFile('/docs/note.md'))).toBe('v2 is longer')
	const statA = await a.vol.stat('/docs/note.md')
	const statB = await b.vol.stat('/docs/note.md')
	expect(statB.size).toBe(statA.size)
	expect(statB.mtimeNs).toBe(statA.mtimeNs)
})

// ── Cycle 5: delete tombstone and path reuse ──────────────────────────────────

test('a delete tombstones its id and a recreated path gets a new one', async () => {
	const { a, b, sync } = nodePeers()
	await a.vol.mkdir('/docs')
	await a.vol.writeFile('/docs/note.md', bytes('one'))
	await sync()
	const oldId = (await a.nodeAt('/docs/note.md'))?.id ?? ''

	await a.vol.rm('/docs/note.md')
	await sync()

	expect(await b.vol.exists('/docs/note.md')).toBe(false)
	// Identity outlives the inode it was bound to.
	expect(await a.nodes.get(oldId)).toMatchObject({ deleted: true, localIno: null })
	expect(await b.nodes.get(oldId)).toMatchObject({ deleted: true, localIno: null })

	await a.vol.writeFile('/docs/note.md', bytes('two'))
	await sync()

	const newA = await a.nodeAt('/docs/note.md')
	const newB = await b.nodeAt('/docs/note.md')
	expect(newA?.id).toBeTruthy()
	expect(newB?.id).toBe(newA?.id)
	expect(newA?.id).not.toBe(oldId)
	expect(text(await b.vol.readFile('/docs/note.md'))).toBe('two')
	// The tombstone survives the reuse of its path.
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

	expect(sent.map((m) => m.kind)).toEqual(['delete', 'delete', 'delete'])
	expect(sent.map((m) => m.nodeId)).toEqual(ids)
	expect(await b.vol.exists('/tree')).toBe(false)
})

test('a rename over a live file tombstones the file it displaced', async () => {
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

// ── Cycle 6: retry is idempotent ──────────────────────────────────────────────

test('re-delivering an accepted create, update, move and delete changes nothing', async () => {
	const { a, b, deliver } = nodePeers()
	await a.vol.mkdir('/dir')
	await a.vol.mkdir('/other')
	await a.vol.writeFile('/dir/f.txt', bytes('one'))
	await a.vol.writeFile('/dir/f.txt', bytes('two')) // update
	await a.vol.rename('/dir/f.txt', '/other/f.txt') // move
	await a.vol.writeFile('/dir/tmp.txt', bytes('tmp'))
	await a.vol.rm('/dir/tmp.txt') // delete

	const once = await deliver(1)
	const settled = await b.nodeAt('/other/f.txt')
	await b.replica.applyNodeOperations(once, () => Promise.reject(new Error('no refetch')), {
		source: REMOTE
	})
	await deliver(1) // and the whole stream a third time

	const again = await b.nodeAt('/other/f.txt')
	expect(again).toEqual(settled)
	expect(again?.id).toBe((await a.nodeAt('/other/f.txt'))?.id)
	expect(again?.revision).toBe((await a.nodeAt('/other/f.txt'))?.revision)
	expect(text(await b.vol.readFile('/other/f.txt'))).toBe('two')
	expect(await b.vol.exists('/dir/f.txt')).toBe(false)
	expect(await b.vol.exists('/dir/tmp.txt')).toBe(false)
	expect(await b.orphanCount()).toBe(0)
	expect((await b.vol.readdir('/other')).map((e) => e.name)).toEqual(['f.txt'])
})

// ── Cycle 7: ordered bootstrap ────────────────────────────────────────────────

test('a paged bootstrap applies parents before children and loses no delta', async () => {
	const { a, b, bootstrap, sync } = nodePeers()
	const leaves: string[] = []
	for (let i = 0; i < 4; i++) {
		let path = ''
		for (let depth = 0; depth < 4; depth++) path += `/d${i}x${depth}`
		await a.vol.mkdir(path, { recursive: true })
		await a.vol.writeFile(`${path}/leaf.txt`, bytes(`leaf ${i}`))
		leaves.push(`${path}/leaf.txt`)
	}

	// Every create must name a parent this replica already holds, or one applied
	// earlier in the SAME page.
	const known = new Set<string>([ROOT_NODE_ID])
	const pages = await bootstrap(3, async (operations, page) => {
		for (const m of mutationsOf(operations)) {
			expect(m.kind).toBe('create')
			if (m.kind !== 'create') continue
			expect(known.has(m.parentId)).toBe(true)
			known.add(m.nodeId)
		}
		// A write DURING the scan must still reach B. `/aaa-late.txt` sorts BELOW the
		// path this page ended at, so no later page can carry it — only the delta
		// stream resuming at the frozen cursor can.
		if (page === 1) await a.vol.writeFile('/aaa-late.txt', bytes('late'))
	})

	expect(pages.length).toBeGreaterThan(3)
	// Every page is cut at the SAME frozen high-water.
	expect(new Set(pages).size).toBe(1)

	for (const [i, leaf] of leaves.entries())
		expect(text(await b.vol.readFile(leaf))).toBe(`leaf ${i}`)
	expect(await b.orphanCount()).toBe(0)
	expect(await b.vol.exists('/aaa-late.txt')).toBe(false)

	await sync()
	expect(text(await b.vol.readFile('/aaa-late.txt'))).toBe('late')
	expect((await b.nodeAt('/aaa-late.txt'))?.id).toBe((await a.nodeAt('/aaa-late.txt'))?.id)
})

// ── Cycle 8: ignored data is absent from the wire ─────────────────────────────

test('an ignored subtree gets no identity and never reaches the wire', async () => {
	const { a, b, sent, fetched, sync } = nodePeers({ ignore: ['/private'] })
	await a.vol.mkdir('/private/keys', { recursive: true })
	await a.vol.writeFile('/private/keys/token', bytes('A secret'))
	await a.vol.writeFile('/shared.txt', bytes('shared'))
	await b.vol.mkdir('/private/keys', { recursive: true })
	await b.vol.writeFile('/private/keys/token', bytes('B secret'))
	const secret = (await a.vol.stat('/private/keys/token')).contentHash

	await sync()

	// Outside the projection is outside IDENTITY: there is nothing to name.
	expect(await a.nodeAt('/private')).toBe(null)
	expect(await a.nodeAt('/private/keys')).toBe(null)
	expect(await a.nodeAt('/private/keys/token')).toBe(null)

	// An update and a delete of ignored data journal nothing either.
	const head = await a.nodes.head()
	await a.vol.writeFile('/private/keys/token', bytes('A secret v2'))
	await a.vol.rm('/private/keys/token')
	expect(await a.nodes.head()).toBe(head)

	await sync()

	// Each replica keeps its own bytes at the same ignored path.
	expect(await a.vol.exists('/private/keys/token')).toBe(false)
	expect(text(await b.vol.readFile('/private/keys/token'))).toBe('B secret')

	// Nothing about them crossed: no mutation, no tombstone, no blob request.
	const named = sent.flatMap((m) => (m.kind === 'create' || m.kind === 'move' ? [m.name] : []))
	expect(named).not.toContain('private')
	expect(named).not.toContain('token')
	expect(fetched).not.toContain(secret)
	// A full snapshot cannot disclose them either.
	const scan = await a.replica.nodeScan()
	expect(
		mutationsOf(scan.operations).flatMap((m) => (m.kind === 'create' ? [m.name] : []))
	).toEqual(['shared.txt'])

	// The engine keeps its own state OUT of the volume, without being told to.
	expect((await b.vol.readdir('/')).map((e) => e.name).sort()).toEqual(['private', 'shared.txt'])
	expect((await a.vol.readdir('/')).map((e) => e.name).sort()).toEqual(['private', 'shared.txt'])
})

// ── Cycle 9: all four local move transitions ──────────────────────────────────

test('visible -> visible is still one move when an ignore list is configured', async () => {
	const { a, sentOps, sync } = nodePeers({ ignore: ['/private'] })
	await a.vol.mkdir('/one/two', { recursive: true })
	await a.vol.writeFile('/one/two/f.txt', bytes('f'))
	await sync()
	sentOps.length = 0

	await a.vol.rename('/one', '/uno')
	await sync()

	expect(sentOps).toHaveLength(1)
	expect(sentOps[0]?.mutations.map((m) => m.kind)).toEqual(['move'])
})

test('ignored -> ignored records nothing at all', async () => {
	const { a, b, sync } = nodePeers({ ignore: ['/private'] })
	await a.vol.mkdir('/private/box', { recursive: true })
	await a.vol.writeFile('/private/box/f.txt', bytes('x'))
	await sync()
	const head = await a.nodes.head()

	await a.vol.rename('/private/box', '/private/moved')

	expect(await a.nodes.head()).toBe(head)
	await sync()
	expect(await b.vol.exists('/private')).toBe(false)
	expect(text(await a.vol.readFile('/private/moved/f.txt'))).toBe('x')
})

test('ignored -> visible publishes the whole subtree parent-first with fresh ids', async () => {
	const { a, b, sentOps, fetched, sync } = nodePeers({ aIgnore: ['/private'] })
	await a.vol.mkdir('/private/box/deep', { recursive: true })
	await a.vol.writeFile('/private/box/deep/f.txt', bytes('deep'))
	await a.vol.writeFile('/private/box/top.txt', bytes('top'))
	await a.vol.mkdir('/pub')
	await sync()
	expect(await b.vol.exists('/pub')).toBe(true)
	sentOps.length = 0
	fetched.length = 0

	await a.vol.rename('/private/box', '/pub/box')
	await sync()

	// ONE publication, parent before child, every node freshly identified.
	expect(sentOps).toHaveLength(1)
	const mutations = sentOps[0]?.mutations ?? []
	expect(mutations.map((m) => m.kind)).toEqual(['create', 'create', 'create', 'create'])
	expect(mutations.map((m) => (m.kind === 'create' ? m.name : ''))).toEqual([
		'box',
		'deep',
		'f.txt',
		'top.txt'
	])

	expect(text(await b.vol.readFile('/pub/box/deep/f.txt'))).toBe('deep')
	expect(text(await b.vol.readFile('/pub/box/top.txt'))).toBe('top')
	expect((await b.nodeAt('/pub/box'))?.id).toBe((await a.nodeAt('/pub/box'))?.id)
	// Only the missing bytes were transferred.
	expect(fetched).toHaveLength(2)
})

test('visible -> ignored unpublishes child-first, keeps local bytes, never reuses ids', async () => {
	const { a, b, sentOps, sync } = nodePeers({ aIgnore: ['/hide'] })
	await a.vol.mkdir('/box/deep', { recursive: true })
	await a.vol.writeFile('/box/deep/f.txt', bytes('deep'))
	await a.vol.writeFile('/box/top.txt', bytes('top'))
	await a.vol.mkdir('/hide')
	await sync()
	const before = {
		box: (await a.nodeAt('/box'))?.id ?? '',
		deep: (await a.nodeAt('/box/deep'))?.id ?? '',
		file: (await a.nodeAt('/box/deep/f.txt'))?.id ?? '',
		top: (await a.nodeAt('/box/top.txt'))?.id ?? ''
	}
	expect(await b.vol.exists('/box/deep/f.txt')).toBe(true)
	sentOps.length = 0

	await a.vol.rename('/box', '/hide/box')
	await sync()

	// ONE unpublication, child before parent, naming every shared node it removes.
	expect(sentOps).toHaveLength(1)
	const mutations = sentOps[0]?.mutations ?? []
	expect(mutations.map((m) => m.kind)).toEqual(['delete', 'delete', 'delete', 'delete'])
	const removed = mutations.map((m) => m.nodeId)
	expect(new Set(removed)).toEqual(new Set(Object.values(before)))
	expect(removed.indexOf(before.file)).toBeLessThan(removed.indexOf(before.deep))
	expect(removed.indexOf(before.deep)).toBeLessThan(removed.indexOf(before.box))
	expect(removed.indexOf(before.top)).toBeLessThan(removed.indexOf(before.box))

	// The remote subtree is gone; the local bytes are untouched.
	expect(await b.vol.exists('/box')).toBe(false)
	expect(text(await a.vol.readFile('/hide/box/deep/f.txt'))).toBe('deep')
	for (const id of Object.values(before)) {
		expect(await a.nodes.get(id)).toMatchObject({ deleted: true })
		expect(await b.nodes.get(id)).toMatchObject({ deleted: true })
	}

	// Coming back is a NEW publication: identity does not survive the round trip.
	await a.vol.rename('/hide/box', '/box')
	await sync()
	expect(text(await b.vol.readFile('/box/deep/f.txt'))).toBe('deep')
	expect((await a.nodeAt('/box'))?.id).not.toBe(before.box)
	expect((await a.nodeAt('/box/deep/f.txt'))?.id).not.toBe(before.file)
	expect((await b.nodeAt('/box'))?.id).toBe((await a.nodeAt('/box'))?.id)
})

test('a move whose descendant LEAVES the projection is one atomic operation', async () => {
	const { a, b, sentOps, sync } = nodePeers({ aIgnore: ['/dst/hidden'] })
	await a.vol.mkdir('/src/hidden/deep', { recursive: true })
	await a.vol.writeFile('/src/hidden/deep/f.txt', bytes('secret'))
	await a.vol.writeFile('/src/open.txt', bytes('open'))
	await sync()
	expect(await b.vol.exists('/src/hidden/deep/f.txt')).toBe(true)
	sentOps.length = 0

	await a.vol.rename('/src', '/dst')
	await sync()

	expect(sentOps).toHaveLength(1)
	const kinds = sentOps[0]?.mutations.map((m) => m.kind) ?? []
	expect(kinds).toEqual(['delete', 'delete', 'delete', 'move'])

	expect(text(await b.vol.readFile('/dst/open.txt'))).toBe('open')
	// The subtree that crossed the boundary was never exposed at its new path.
	expect(await b.vol.exists('/dst/hidden')).toBe(false)
	expect(await b.vol.exists('/src')).toBe(false)
	// A keeps its own bytes behind the boundary.
	expect(text(await a.vol.readFile('/dst/hidden/deep/f.txt'))).toBe('secret')
})

test('a move whose descendant ENTERS the projection is one atomic operation', async () => {
	const { a, b, sentOps, sync } = nodePeers({ aIgnore: ['/src/hidden'] })
	await a.vol.mkdir('/src/hidden/deep', { recursive: true })
	await a.vol.writeFile('/src/hidden/deep/f.txt', bytes('now shared'))
	await a.vol.writeFile('/src/open.txt', bytes('open'))
	await sync()
	expect(await b.vol.exists('/src/hidden')).toBe(false)
	sentOps.length = 0

	await a.vol.rename('/src', '/dst')
	await sync()

	expect(sentOps).toHaveLength(1)
	const mutations = sentOps[0]?.mutations ?? []
	expect(mutations.map((m) => m.kind)).toEqual(['move', 'create', 'create', 'create'])
	expect(mutations.map((m) => (m.kind === 'delete' || m.kind === 'update' ? '' : m.name))).toEqual([
		'dst',
		'hidden',
		'deep',
		'f.txt'
	])

	expect(text(await b.vol.readFile('/dst/hidden/deep/f.txt'))).toBe('now shared')
	expect(text(await b.vol.readFile('/dst/open.txt'))).toBe('open')
	// The relocated root kept its identity; only the newly visible part is new.
	expect((await b.nodeAt('/dst'))?.id).toBe((await a.nodeAt('/dst'))?.id)
	expect((await b.nodeAt('/dst/hidden'))?.id).toBe((await a.nodeAt('/dst/hidden'))?.id)
})

// ── Cycle 10: receiving projection and ancestor shielding ─────────────────────

test('a remote move across the RECEIVER boundary drops and restores its materialisation', async () => {
	const { a, b, echoed, sync } = nodePeers({ bIgnore: ['/vault', '/again/box/secret'] })
	await a.vol.mkdir('/vault')
	await a.vol.mkdir('/again')
	await a.vol.mkdir('/box/deep', { recursive: true })
	await a.vol.mkdir('/box/secret')
	await a.vol.writeFile('/box/secret/s.txt', bytes('classified'))
	await a.vol.writeFile('/box/deep/f.txt', bytes('payload'))
	await sync()

	// A node B declines to materialise is state only — never a tombstone.
	expect(await b.vol.exists('/vault')).toBe(false)
	const vaultId = (await a.nodeAt('/vault'))?.id ?? ''
	expect(await b.nodes.get(vaultId)).toMatchObject({ deleted: false, localIno: null })
	expect(text(await b.vol.readFile('/box/deep/f.txt'))).toBe('payload')

	const boxId = (await a.nodeAt('/box'))?.id ?? ''
	const fileId = (await a.nodeAt('/box/deep/f.txt'))?.id ?? ''

	// Visible -> ignored, from B's point of view: remove the materialisation only.
	await a.vol.rename('/box', '/vault/box')
	await sync()

	expect(await b.vol.exists('/box')).toBe(false)
	expect(await b.nodes.get(boxId)).toMatchObject({ deleted: false, localIno: null })
	expect(await b.nodes.get(fileId)).toMatchObject({ deleted: false, localIno: null })
	expect(text(await a.vol.readFile('/vault/box/deep/f.txt'))).toBe('payload')
	expect(echoed).toEqual([])

	// B no longer names those bytes, so a sweep may reclaim them.
	await b.storage.caps?.content?.gcUnreferenced()

	// Ignored -> visible: fetch the missing descendants and materialise them all.
	await a.vol.rename('/vault/box', '/again/box')
	await sync()

	expect(text(await b.vol.readFile('/again/box/deep/f.txt'))).toBe('payload')
	// The subtree never left the SENDER's projection, so identity is unchanged.
	expect((await b.nodeAt('/again/box'))?.id).toBe(boxId)
	expect((await b.nodeAt('/again/box/deep/f.txt'))?.id).toBe(fileId)
	// A nested ignore root inside what came back into view still keeps it out.
	expect(await b.vol.exists('/again/box/secret')).toBe(false)
	expect(text(await a.vol.readFile('/again/box/secret/s.txt'))).toBe('classified')
	expect(echoed).toEqual([])
})

test('a remote ancestor delete or replacement cannot destroy a locally ignored child', async () => {
	const { a, b, echoed, sync } = nodePeers({ bIgnore: ['/box/cache'] })
	await a.vol.mkdir('/box')
	await a.vol.writeFile('/box/shared.txt', bytes('shared'))
	await sync()
	await b.vol.mkdir('/box/cache')
	await b.vol.writeFile('/box/cache/keep.bin', bytes('B only'))

	await a.vol.rm('/box', { recursive: true })
	await sync()

	// The directory survives BECAUSE it holds something B must keep; the shared
	// child it also held does not.
	expect(text(await b.vol.readFile('/box/cache/keep.bin'))).toBe('B only')
	expect(await b.vol.exists('/box/shared.txt')).toBe(false)
	// Skipping mutates nothing, so there is nothing to push back and no flapping.
	expect(echoed).toEqual([])

	// The same directory, replaced upstream by a regular file.
	await a.vol.writeFile('/box', bytes('now a file'))
	await sync()

	expect(text(await b.vol.readFile('/box/cache/keep.bin'))).toBe('B only')
	expect((await b.vol.lstat('/box')).type).toBe(FileType.Directory)
	expect(echoed).toEqual([])
})

// ── Asymmetric policies: a replica never holds or re-serves what it hides ──────

test('a receiver fetches no bytes for a node its own policy hides', async () => {
	const { a, b, fetched, sync } = nodePeers({ bIgnore: ['/vault'] })
	await a.vol.mkdir('/vault/deep', { recursive: true })
	await a.vol.writeFile('/vault/deep/secret.txt', bytes('classified'))
	await a.vol.writeFile('/open.txt', bytes('open'))
	const secret = (await a.vol.stat('/vault/deep/secret.txt')).contentHash ?? ''
	const open = (await a.vol.stat('/open.txt')).contentHash ?? ''

	await sync()

	// B holds the STATE (it is not a tombstone) but never asked for the bytes.
	expect(await b.nodes.get((await a.nodeAt('/vault'))?.id ?? '')).toMatchObject({ deleted: false })
	expect(fetched).toContain(open)
	expect(fetched).not.toContain(secret)
	expect(await b.replica.hasBlobByHash(secret)).toBe(false)
})

test('a receiver does not re-serve a snapshot of what its own policy hides', async () => {
	const { a, b, sync } = nodePeers({ bIgnore: ['/vault'] })
	await a.vol.mkdir('/vault/deep', { recursive: true })
	await a.vol.writeFile('/vault/deep/secret.txt', bytes('classified'))
	await a.vol.writeFile('/open.txt', bytes('open'))

	await sync()

	const scan = await b.replica.nodeScan()
	const named = mutationsOf(scan.operations).map((m) => (m.kind === 'create' ? m.name : ''))
	expect(named).toEqual(['open.txt'])
	// A, which hides nothing, still serves the whole tree.
	expect(mutationsOf((await a.replica.nodeScan()).operations)).toHaveLength(4)
})

test('a remote move that crosses a nested RECEIVER ignore reconciles the descendants', async () => {
	const { a, b, fetched, sync } = nodePeers({ bIgnore: ['/dst/hidden'] })
	await a.vol.mkdir('/src/hidden/deep', { recursive: true })
	await a.vol.writeFile('/src/hidden/deep/f.txt', bytes('secret'))
	await a.vol.writeFile('/src/open.txt', bytes('open'))
	await sync()
	// Nothing is hidden at `/src`, so B holds the whole subtree.
	expect(text(await b.vol.readFile('/src/hidden/deep/f.txt'))).toBe('secret')
	const hiddenId = (await a.nodeAt('/src/hidden'))?.id ?? ''

	// The moved root stays visible to B; one descendant crosses INTO its ignore.
	await a.vol.rename('/src', '/dst')
	await sync()

	expect(text(await b.vol.readFile('/dst/open.txt'))).toBe('open')
	expect(await b.vol.exists('/dst/hidden')).toBe(false)
	expect(await b.nodes.get(hiddenId)).toMatchObject({ deleted: false, localIno: null })

	// And back out: the descendant returns, bytes and all.
	await b.storage.caps?.content?.gcUnreferenced()
	fetched.length = 0
	await a.vol.rename('/dst', '/back')
	await sync()

	expect(text(await b.vol.readFile('/back/hidden/deep/f.txt'))).toBe('secret')
	expect((await b.nodeAt('/back/hidden'))?.id).toBe(hiddenId)
	expect(text(await b.vol.readFile('/back/open.txt'))).toBe('open')
})

test('a relaying replica does not pass on what its own policy hides', async () => {
	const { a, b, sync } = nodePeers({ bIgnore: ['/vault'] })
	await a.vol.mkdir('/vault')
	await a.vol.writeFile('/vault/secret.txt', bytes('classified'))
	await a.vol.writeFile('/open.txt', bytes('open'))
	await sync()

	// C pulls B's WHOLE journal, including the rows B applied from A.
	const c = makePeer('c')
	const relayed = await b.replica.nodeDeltas('', { limit: 500 })
	const named = mutationsOf(relayed.operations).map((m) => (m.kind === 'create' ? m.name : ''))
	expect(named).not.toContain('vault')
	expect(named).not.toContain('secret.txt')

	await c.replica.applyNodeOperations(relayed.operations, (hash) => b.replica.getBlobByHash(hash), {
		source: REMOTE
	})
	expect(await c.vol.exists('/vault')).toBe(false)
	expect(text(await c.vol.readFile('/open.txt'))).toBe('open')
})

test('a relay refuses a stream it cannot express rather than dropping the transition', async () => {
	const { a, b, sync } = nodePeers({ bIgnore: ['/vault'] })
	await a.vol.mkdir('/vault')
	await a.vol.writeFile('/foo.txt', bytes('shared'))
	await sync()

	// C is mid-stream over B's relayed journal, and already holds /foo.txt.
	const c = makePeer('c')
	const first = await b.replica.nodeDeltas('', { limit: 500 })
	await c.replica.applyNodeOperations(first.operations, (h) => b.replica.getBlobByHash(h), {
		source: REMOTE
	})
	expect(text(await c.vol.readFile('/foo.txt'))).toBe('shared')

	// A hides it behind B's boundary. B cannot relay that as a move — the node it
	// names is one B may not describe — and silently dropping it would leave C
	// holding /foo.txt with no correction ever coming.
	await a.vol.rename('/foo.txt', '/vault/foo.txt')
	await sync()

	await expect(b.replica.nodeDeltas(first.to, { limit: 500 })).rejects.toThrow(
		ProjectionCursorError
	)
	// Refusing discloses nothing, and leaves the cursor where it was.
	const reopened = await b.replica.nodeScan()
	const named = mutationsOf(reopened.operations).map((m) => (m.kind === 'create' ? m.name : ''))
	expect(named).not.toContain('vault')
	expect(named).not.toContain('foo.txt')
})

test('a nested crossing is planned by tree spelling, not by the ignore list spelling', async () => {
	// The ignore root is composed; the directory in the tree is decomposed.
	const composed = '/dst/caf\u00e9'
	const decomposed = 'cafe\u0301'
	const { a, b, sync } = nodePeers({ bIgnore: [composed] })
	await a.vol.mkdir(`/src/${decomposed}`, { recursive: true })
	await a.vol.writeFile(`/src/${decomposed}/f.txt`, bytes('secret'))
	await a.vol.writeFile('/src/open.txt', bytes('open'))
	await sync()
	expect(text(await b.vol.readFile(`/src/${decomposed}/f.txt`))).toBe('secret')

	await a.vol.rename('/src', '/dst')
	await sync()

	// B must recognise the decomposed child as the composed root it was given.
	expect(text(await b.vol.readFile('/dst/open.txt'))).toBe('open')
	expect(await b.vol.exists(`/dst/${decomposed}`)).toBe(false)
})

test('an unpublication finds the crossing subtree whatever its spelling', async () => {
	const composed = '/dst/caf\u00e9'
	const decomposed = 'cafe\u0301'
	const { a, b, sentOps, sync } = nodePeers({ aIgnore: [composed] })
	await a.vol.mkdir(`/src/${decomposed}`, { recursive: true })
	await a.vol.writeFile(`/src/${decomposed}/f.txt`, bytes('secret'))
	await a.vol.writeFile('/src/open.txt', bytes('open'))
	await sync()
	expect(text(await b.vol.readFile(`/src/${decomposed}/f.txt`))).toBe('secret')
	sentOps.length = 0

	await a.vol.rename('/src', '/dst')
	await sync()

	// The subtree left A's projection, so A withdraws it — matching the tree's
	// spelling, not the one the caller happened to configure.
	expect(sentOps).toHaveLength(1)
	expect(sentOps[0]?.mutations.map((m) => m.kind)).toEqual(['delete', 'delete', 'move'])
	expect(await b.vol.exists(`/dst/${decomposed}`)).toBe(false)
	expect(text(await b.vol.readFile('/dst/open.txt'))).toBe('open')
	// A keeps its own bytes behind the boundary.
	expect(text(await a.vol.readFile(`/dst/${decomposed}/f.txt`))).toBe('secret')
})

test('an ignore root matches whatever Unicode spelling the tree holds', async () => {
	// The tree holds the DECOMPOSED spelling (what a macOS volume hands back); the
	// caller configured the composed one. Same path, two encodings — written as
	// escapes so no editor can quietly normalise the test into a tautology.
	const decomposed = '/cafe\u0301'
	const composed = '/caf\u00e9'
	expect(decomposed).not.toBe(composed)
	const { a, b, sync } = nodePeers({ aIgnore: [composed] })
	await a.vol.mkdir(decomposed)
	await a.vol.writeFile(`${decomposed}/f.txt`, bytes('hidden'))
	await a.vol.writeFile('/open.txt', bytes('open'))

	await sync()

	expect(await a.nodeAt(`${decomposed}/f.txt`)).toBe(null)
	expect(await b.vol.exists(decomposed)).toBe(false)
	expect(text(await b.vol.readFile('/open.txt'))).toBe('open')
})

test('an ignore root is canonicalised before it is matched', async () => {
	const { a, b, sync } = nodePeers({ aIgnore: ['/x/../private', '//dup//keys/', '/./dot'] })
	for (const dir of ['/private', '/dup/keys', '/dot']) {
		await a.vol.mkdir(dir, { recursive: true })
		await a.vol.writeFile(`${dir}/f.txt`, bytes('hidden'))
	}
	await a.vol.writeFile('/open.txt', bytes('open'))

	await sync()

	for (const dir of ['/private', '/dup/keys', '/dot']) {
		expect(await a.nodeAt(`${dir}/f.txt`)).toBe(null)
		expect(await b.vol.exists(`${dir}/f.txt`)).toBe(false)
	}
	expect(text(await b.vol.readFile('/open.txt'))).toBe('open')
})
