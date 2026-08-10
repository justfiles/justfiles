// The sync snapshot, served from the TREE (#398 step 2).
//
// Coalescing the journal to answer "what does this volume hold?" is what pinned
// journal retention to one row per path forever: an emptied journal reported an
// empty volume. These tests hold the snapshot to the tree instead — including the
// case that used to be impossible, a full volume behind an EMPTY journal.

import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { volume } from '@justfiles/fs'
import { treeChangeSource } from '@justfiles/fs/sync-replica'
import type { PathChange } from '@justfiles/fs/sync-wire'
import { FileType } from '@justfiles/fs/types'
import { describe, expect, it } from 'vitest'
import { createSqliteAdapter } from './db.sqlite'
import { createFsApi } from './fs'
import { storage as sqliteStorage } from './storage.sqlite'

const migrationsDir = new URL('./migrations/', import.meta.url)
const schema = readdirSync(migrationsDir)
	.filter((f) => f.endsWith('.sql'))
	.sort()
	.map((f) => readFileSync(new URL(f, migrationsDir), 'utf8'))
	.join('\n')

function makeSqlite() {
	const db = new DatabaseSync(':memory:')
	db.exec(schema)
	const db64 = {
		prepare(sql: string) {
			const stmt = db.prepare(sql)
			stmt.setReadBigInts(true)
			return stmt
		},
		exec: (sql: string) => db.exec(sql)
	}
	const storage = sqliteStorage(
		createSqliteAdapter(db64 as unknown as Parameters<typeof createSqliteAdapter>[0])
	)
	return { db, storage, vol: volume(storage) }
}

const bytes = (s: string) => new TextEncoder().encode(s)
const paths = (changes: PathChange[]) => changes.map((c) => c.path)

function snapshotOf(storage: ReturnType<typeof makeSqlite>['storage']) {
	const snapshot = storage.caps?.pathSnapshot
	if (!snapshot) throw new Error('sqlite must serve a tree snapshot')
	return snapshot
}

describe('sqlite caps.pathSnapshot', () => {
	it('reports every live path as a put, in parent-before-child order', async () => {
		const { storage, vol } = makeSqlite()
		await vol.mkdir('/notes')
		await vol.writeFile('/notes/one.md', bytes('one'))
		await vol.writeFile('/top.md', bytes('top'))

		const changes = await snapshotOf(storage).puts('', 100)

		expect(paths(changes)).toEqual(['/notes', '/notes/one.md', '/top.md'])
		const one = changes[1]
		if (one?.kind !== 'put') throw new Error('expected a put')
		expect(one.contentHash).toBe((await vol.stat('/notes/one.md')).contentHash)
		expect(one.version).toBe('1')
	})

	it('carries the current version, not the first one', async () => {
		const { storage, vol } = makeSqlite()
		await vol.writeFile('/state.json', bytes('v1'))
		await vol.writeFile('/state.json', bytes('v2'))

		expect((await snapshotOf(storage).puts('', 100))[0]?.version).toBe('2')
	})

	it('carries the user xattrs the wire snapshot replaces on apply', async () => {
		const { storage, vol } = makeSqlite()
		await vol.writeFile('/tagged.md', bytes('hi'))
		const { ino } = await vol.stat('/tagged.md')
		await storage.caps?.setXattr?.(ino, 'user.tag', bytes('red'))

		const [change] = await snapshotOf(storage).puts('', 100)
		if (change?.kind !== 'put') throw new Error('expected a put')
		expect(change.meta.xattrs).toEqual({ 'user.tag': btoa('red') })
	})

	it('pages by path, and a full page is never short', async () => {
		const { storage, vol } = makeSqlite()
		for (const name of ['a', 'b', 'c', 'd']) await vol.writeFile(`/${name}.md`, bytes(name))

		const first = await snapshotOf(storage).puts('', 2)
		expect(paths(first)).toEqual(['/a.md', '/b.md'])
		const second = await snapshotOf(storage).puts('/b.md', 2)
		expect(paths(second)).toEqual(['/c.md', '/d.md'])
		expect(await snapshotOf(storage).puts('/d.md', 2)).toEqual([])
	})

	it('omits a regular file with no content — a put the wire could not hydrate', async () => {
		const { storage, vol } = makeSqlite()
		await vol.writeFile('/real.md', bytes('real'))
		// A claim with no bytes yet: the journal skips its put for the same reason
		// (`buildPutChange`), and its content write journals one once hashed.
		await storage.caps?.atomicCreate?.(storage.rootIno, 'empty.md', {
			type: FileType.Regular,
			size: 0n,
			mode: 0o644,
			mtimeNs: 0n,
			ctimeNs: 0n
		})

		expect(paths(await snapshotOf(storage).puts('', 100))).toEqual(['/real.md'])
	})

	it('still reports the whole volume when the journal is empty', async () => {
		// The point of the change: journal retention is now a performance question.
		const { db, storage, vol } = makeSqlite()
		await vol.writeFile('/kept.md', bytes('kept'))
		db.exec('DELETE FROM fs_path_journal')

		expect(paths(await snapshotOf(storage).puts('', 100))).toEqual(['/kept.md'])
	})
})

describe('treeChangeSource', () => {
	it('reports the live tree, and nothing the journal still remembers', async () => {
		const { storage, vol } = makeSqlite()
		await vol.writeFile('/a.md', bytes('a'))
		await vol.rm('/a.md')
		await vol.writeFile('/b.md', bytes('b'))

		const page = await treeChangeSource(storage).pathScan(undefined, { limit: 100 })

		expect(paths(page.changes)).toEqual(['/b.md'])
		expect(page.done).toBe(true)
	})

	it('pages by path, cutting every page at the same frozen high-water', async () => {
		const { storage, vol } = makeSqlite()
		for (const name of ['a', 'b', 'c']) await vol.writeFile(`/${name}.md`, bytes(name))
		const source = treeChangeSource(storage)

		const first = await source.pathScan(undefined, { limit: 2 })
		expect(paths(first.changes)).toEqual(['/a.md', '/b.md'])
		expect(first.done).toBe(false)

		const second = await source.pathScan(first.next, { limit: 2 })
		expect(paths(second.changes)).toEqual(['/c.md'])
		expect(second.done).toBe(true)
		expect(second.syncCursor).toBe(first.syncCursor)
	})

	it('resumes a journal-served page token instead of restarting the snapshot', async () => {
		// A bootstrap in flight when the server switched sources holds `head:path`, which
		// this source reads as its own — the token shape is deliberately unchanged.
		const { storage, vol } = makeSqlite()
		for (const name of ['a', 'b', 'c']) await vol.writeFile(`/${name}.md`, bytes(name))

		const page = await treeChangeSource(storage).pathScan(`9:${encodeURIComponent('/b.md')}`, {
			limit: 100
		})

		expect(paths(page.changes)).toEqual(['/c.md'])
		expect(page.syncCursor).toBe('9')
	})

	it('reads deltas from the journal, exactly as the journal-served source does', async () => {
		const { storage, vol } = makeSqlite()
		await vol.writeFile('/a.md', bytes('a'))

		const delta = await treeChangeSource(storage).pathDeltas('', { limit: 100 })

		expect(paths(delta.changes)).toEqual(['/a.md'])
		expect(delta.done).toBe(true)
	})
})

describe('GET /path/snapshot', () => {
	type Page = { changes: PathChange[]; next?: string; done: boolean }

	/** Page the whole snapshot the way a bootstrap does — follow `next` until done. */
	async function drain(app: ReturnType<typeof createFsApi>): Promise<string[]> {
		const puts: string[] = []
		let page: string | undefined
		for (;;) {
			const query = new URLSearchParams()
			if (page !== undefined) query.set('page', page)
			const res = await app.request(`/path/snapshot?${query}`)
			expect(res.status).toBe(200)
			const body = (await res.json()) as Page
			puts.push(...paths(body.changes))
			if (body.done || body.next === undefined) return puts
			page = body.next
		}
	}

	it('serves the live tree, not a replay of the journal', async () => {
		const { storage, vol } = makeSqlite()
		await vol.writeFile('/gone.md', bytes('gone'))
		await vol.rm('/gone.md')
		await vol.writeFile('/here.md', bytes('here'))
		const app = createFsApi(storage)

		expect(await drain(app)).toEqual(['/here.md'])
	})

	it('never names a private path', async () => {
		const { storage, vol } = makeSqlite()
		await vol.mkdir('/private', { recursive: true })
		await vol.writeFile('/private/token', bytes('secret'))
		await vol.writeFile('/public.md', bytes('public'))
		const app = createFsApi(storage)

		expect(await drain(app)).toEqual(['/public.md'])
	})
})
