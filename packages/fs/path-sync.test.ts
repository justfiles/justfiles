/**
 * Layer 2 — path-sync semantics, plus a property test. The harness drives the
 * REAL `SyncReplica` methods end to end. The related schema test lives in
 * `sync-units.test.ts`.
 */

import { afterEach, describe, expect, test } from 'vitest'
import { memStorage } from './storage.mem'
import {
	adoptionPeers,
	bytes,
	mulberry32,
	numericIno,
	orphanCount,
	randomOp,
	sha256,
	text,
	treeSnapshot,
	twoPeers,
	uuidIno,
	wire
} from './sync-test-harness'
import { FileType } from './types'

describe('path-sync semantics', () => {
	const cleanups: Array<() => void> = []
	afterEach(() => {
		for (const c of cleanups.splice(0)) c()
	})

	// The fork heals (generic path identity, no app semantics)
	test('same path independently created on both sides converges by path version', async () => {
		const { client, server, syncBoth } = twoPeers()
		await server.write('/x/f', bytes('S'), { version: 2 })
		await client.write('/x/f', bytes('C'), { version: 1 })
		await syncBoth()
		expect(text(await client.readFile('/x/f'))).toBe('S')
		expect((await client.readdir('/x')).map((e) => e.name)).toEqual(['f'])
		expect(text(await server.readFile('/x/f'))).toBe('S')
	})

	// Heterogeneous ino spaces sync
	test('syncs between a numeric-ino and a uuid-ino backend, both behind SyncReplica', async () => {
		const native = memStorage({ mintIno: numericIno })
		const uuid = memStorage({ mintIno: uuidIno })
		const { client: n, server: u, syncBoth } = wire(native, uuid)
		await n.writeFile('/data/note.txt', bytes('hello'))
		await syncBoth()
		expect(text(await u.readFile('/data/note.txt'))).toBe('hello')
	})

	// In-place update keeps the local ino
	test('updating content at a path reuses the local inode and converges', async () => {
		const { client, server, syncBoth } = twoPeers()
		await server.writeFile('/applications/computer.spud.code/gui.js', bytes('v1'))
		await syncBoth()
		const inoBefore = (await client.stat('/applications/computer.spud.code/gui.js')).ino
		await server.writeFile('/applications/computer.spud.code/gui.js', bytes('v2'))
		await syncBoth()
		expect(text(await client.readFile('/applications/computer.spud.code/gui.js'))).toBe('v2')
		expect((await client.stat('/applications/computer.spud.code/gui.js')).ino).toBe(inoBefore)
		expect(await orphanCount(client)).toBe(0)
	})

	// Delete propagates by path, across a divergent tree
	test('deleting a path removes it on a peer that had a DIVERGENT local subtree', async () => {
		const { client, server, syncBoth } = twoPeers()
		await server.writeFile('/applications/x/app.js', bytes('S'))
		await client.writeFile('/applications/x/app.js', bytes('C'))
		await syncBoth()
		await server.rm('/applications/x', { recursive: true })
		await syncBoth()
		expect(await client.exists('/applications/x')).toBe(false)
	})

	// Lazy content hydrates by hash, stub retains desired hash
	test('pulled file is a stub carrying the desired hash; first read hydrates by hash', async () => {
		const BIG = 'x'.repeat(4096)
		const { client, server, syncBoth } = twoPeers({ lazyContent: true })
		await server.writeFile('/applications/computer.spud.code/gui.js', bytes(BIG))
		await syncBoth()
		const st = await client.stat('/applications/computer.spud.code/gui.js')
		expect(st.contentHash).toBe(sha256(BIG))
		expect(await client.hasLocalBlob(st.contentHash!)).toBe(false)
		expect(text(await client.readFile('/applications/computer.spud.code/gui.js'))).toBe(BIG)
		expect(await client.hasLocalBlob(st.contentHash!)).toBe(true)
	})

	// First-bootstrap same-path policy (uniform, app-agnostic)
	test('adoption bootstrap: keep local and version it to win; remote loser overwritten', async () => {
		const peers = adoptionPeers()
		cleanups.push(() => peers.destroy())
		await peers.local.writeFile('/notes/todo.md', bytes('LOCAL'))
		await peers.remote.writeFile('/notes/todo.md', bytes('REMOTE'))
		await peers.bootstrapLocalFromRemote()
		expect(text(await peers.local.readFile('/notes/todo.md'))).toBe('LOCAL')
		await peers.syncBoth()
		expect(text(await peers.remote.readFile('/notes/todo.md'))).toBe('LOCAL')
	})

	// Snapshot pages, then pathDeltas(syncCursor) resumes with no gaps
	test('bootstrap pages through pathScan then resumes deltas from syncCursor', async () => {
		const { client, server, bootstrap } = twoPeers()
		for (let i = 0; i < 250; i++) await server.writeFile(`/d/f${i}`, bytes(String(i)))
		const pages = await bootstrap({ limit: 100 })
		await server.writeFile('/d/f0', bytes('changed-after-snapshot-start'))
		await client.pullFrom!(pages.syncCursor)
		expect((await client.readdir('/d')).length).toBe(250)
		expect(text(await client.readFile('/d/f0'))).toBe('changed-after-snapshot-start')
	})

	// Adoption where remote version is higher: local kept, then pushes and wins
	test('adoption keeps local over a higher-version remote and the next push wins', async () => {
		const peers = adoptionPeers()
		cleanups.push(() => peers.destroy())
		await peers.remote.write('/x', bytes('REMOTE'), { version: 2 })
		await peers.local.write('/x', bytes('LOCAL'), { version: 1 })
		await peers.bootstrapLocalFromRemote()
		await peers.syncBoth()
		expect(text(await peers.remote.readFile('/x'))).toBe('LOCAL')
	})

	// /.state and /.state/** never cross the wire
	test('local state at /.state and under it is never pushed or applied', async () => {
		const { client, syncBoth, pushedChanges } = twoPeers()
		await client.writeFile('/notes/a', bytes('hi'))
		await syncBoth()
		const pushed = pushedChanges().map((c) => c.path)
		expect(pushed.some((p) => p === '/.state' || p.startsWith('/.state/'))).toBe(false)
	})

	// Directory rename with children across a page boundary
	test('renaming a directory moves every descendant, even across delta pages', async () => {
		const { client, server, syncBoth } = twoPeers()
		for (let i = 0; i < 150; i++) await server.writeFile(`/old/f${i}`, bytes(String(i)))
		await syncBoth()
		await server.rename('/old', '/new')
		await syncBoth({ limit: 50 })
		expect(await client.exists('/old')).toBe(false)
		expect((await client.readdir('/new')).length).toBe(150)
		expect(text(await client.readFile('/new/f42'))).toBe('42')
	})

	// Type replacement at a path (file<->dir), recursive delete ordering
	test('replacing a file with a dir (and back) converges with correct delete ordering', async () => {
		const { client, server, syncBoth } = twoPeers()
		await server.writeFile('/p', bytes('file'))
		await syncBoth()
		await server.rm('/p')
		await server.mkdir('/p')
		await server.writeFile('/p/child', bytes('c'))
		await syncBoth()
		expect((await client.stat('/p')).type).toBe(FileType.Directory)
		expect(text(await client.readFile('/p/child'))).toBe('c')
		await server.rm('/p', { recursive: true })
		await server.writeFile('/p', bytes('file2'))
		await syncBoth()
		expect((await client.stat('/p')).type).toBe(FileType.Regular)
		expect(text(await client.readFile('/p'))).toBe('file2')
	})

	// Equal-version tie-break is deterministic for every node type
	test('concurrent equal-version, equal-mtime writes pick the SAME winner on both sides', async () => {
		const { client, server, syncBoth } = twoPeers()
		await server.write('/f', bytes('X'), { version: 5, mtimeNs: '100', mode: 0o644 })
		await client.write('/f', bytes('X'), { version: 5, mtimeNs: '100', mode: 0o600 })
		await server.mkdir('/d', { version: 5, mtimeNs: '100', mode: 0o755 })
		await client.mkdir('/d', { version: 5, mtimeNs: '100', mode: 0o700 })
		await syncBoth()
		expect((await client.stat('/f')).mode).toBe((await server.stat('/f')).mode)
		expect((await client.stat('/d')).mode).toBe((await server.stat('/d')).mode)
	})

	// Ancestor delete vs concurrent descendant edit
	test('a winning descendant edit resurrects its deleted ancestor directory', async () => {
		const { client, server, syncBoth } = twoPeers()
		await server.writeFile('/a/b', bytes('v1'))
		await syncBoth()
		await server.rm('/a', { recursive: true })
		await client.write('/a/b', bytes('v2'), { version: 99 })
		await syncBoth()
		expect((await client.stat('/a')).type).toBe(FileType.Directory)
		expect(text(await client.readFile('/a/b'))).toBe('v2')
		expect((await server.stat('/a')).type).toBe(FileType.Directory)
		expect((await client.stat('/a')).mode).toBe(0o755)
		expect((await client.stat('/a')).mode).toBe((await server.stat('/a')).mode)
	})

	// The conflict digest is source-independent
	test('the same durable change wins identically regardless of stamped source', async () => {
		const { client, server, syncBoth } = twoPeers()
		await server.write('/f', bytes('SAME'), { version: 7, mtimeNs: '5', source: undefined })
		await client.write('/f', bytes('SAME'), { version: 7, mtimeNs: '5', source: 'clientA' })
		await syncBoth()
		expect(text(await client.readFile('/f'))).toBe('SAME')
		expect(text(await server.readFile('/f'))).toBe('SAME')
	})

	// #144 item 6 — symlinks sync by target
	test('symlinks sync by target across replicas', async () => {
		const { client, server, syncBoth } = twoPeers()
		await server.writeFile('/target.txt', bytes('data'))
		await server.symlink('/target.txt', '/link')
		await syncBoth()
		expect((await client.lstat('/link')).type).toBe(FileType.Symlink)
		expect(await client.readlink('/link')).toBe('/target.txt')
	})

	// #144 item 1 — snapshot paging race + idempotent scan/delta overlap
	test('snapshot pages share one frozen syncCursor; delta resume overlaps idempotently', async () => {
		const { client, server, bootstrap } = twoPeers()
		for (let i = 0; i < 250; i++) await server.writeFile(`/d/f${i}`, bytes(String(i)))
		let mutated = false
		const { syncCursor, pageCursors } = await bootstrap({
			limit: 100,
			// Mutate the remote MID-snapshot: a correct impl freezes syncCursor at scan
			// start, so this write only surfaces on the post-scan delta resume.
			onPage: async () => {
				if (mutated) return
				mutated = true
				await server.writeFile('/d/f0', bytes('CHANGED'))
			}
		})
		expect(new Set(pageCursors).size).toBe(1) // one frozen high-water across pages
		await client.pullFrom!(syncCursor) // resume deltas at the frozen cursor
		expect((await client.readdir('/d')).length).toBe(250) // no gaps, no dupes
		expect(text(await client.readFile('/d/f0'))).toBe('CHANGED') // delta overlaps snapshot idempotently
	})

	test('snapshot pagination stays complete when GC compacts the journal between pages', async () => {
		const serverStorage = memStorage()
		const { client, server, bootstrap } = wire(memStorage(), serverStorage)
		await server.writeFile('/a', bytes('old'))
		await server.writeFile('/b', bytes('b'))
		await server.writeFile('/a', bytes('current'))
		let compacted = false
		await bootstrap({
			limit: 1,
			onPage: async ({ done }) => {
				if (done || compacted) return
				compacted = true
				await serverStorage.caps!.content!.gcUnreferenced()
			}
		})
		expect(text(await client.readFile('/a'))).toBe('current')
		expect(text(await client.readFile('/b'))).toBe('b')
	})

	test('snapshot pagination survives GC removing an already-emitted frozen row', async () => {
		const serverStorage = memStorage()
		const { client, server, bootstrap } = wire(memStorage(), serverStorage)
		await server.writeFile('/a', bytes('old'))
		await server.writeFile('/b', bytes('b'))
		await server.writeFile('/c', bytes('c'))
		let compacted = false
		const { syncCursor } = await bootstrap({
			limit: 1,
			onPage: async ({ done }) => {
				if (done || compacted) return
				compacted = true
				await server.writeFile('/a', bytes('new'))
				await serverStorage.caps!.content!.gcUnreferenced()
			}
		})
		await client.pullFrom!(syncCursor)
		expect(text(await client.readFile('/a'))).toBe('new')
		expect(text(await client.readFile('/b'))).toBe('b')
		expect(text(await client.readFile('/c'))).toBe('c')
	})

	test('snapshot pagination accepts a legacy offset token across deployment', async () => {
		const { server } = twoPeers()
		await server.writeFile('/b', bytes('b'))
		await server.writeFile('/a', bytes('a'))
		await server.writeFile('/c', bytes('c'))
		const { syncCursor } = await server.replica.pathScan(undefined, { limit: 1 })
		const paths = new Set(['/b']) // first legacy page followed journal order
		let page: string | undefined = `${syncCursor}:1`
		while (page) {
			const result = await server.replica.pathScan(page, { limit: 1 })
			for (const change of result.changes) paths.add(change.path)
			page = result.next
		}
		expect([...paths].sort()).toEqual(['/a', '/b', '/c'])
	})

	// Property test — random ops converge byte-identical with zero orphans
	test('random ops on two peers converge byte-identical with zero orphaned inodes', async () => {
		const { client, server, syncBoth } = twoPeers()
		const rng = mulberry32(0xc0ffee)
		for (let i = 0; i < 60; i++) {
			await randomOp(rng, client)
			await randomOp(rng, server)
		}
		await syncBoth()
		expect(await treeSnapshot(client)).toEqual(await treeSnapshot(server))
		expect(await orphanCount(client)).toBe(0)
		expect(await orphanCount(server)).toBe(0)
	})
})
