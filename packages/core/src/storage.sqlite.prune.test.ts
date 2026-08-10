// The daily journal prune (#398): it is the only sweep that runs against a live
// production volume, inside ONE Durable Object event where `db.transaction` is a
// no-op wrapper — so both its cost per row and its total work per run are the
// subject here, not just its result.

import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { volume } from '@justfiles/fs'
import {
	CursorPrunedError,
	journaledChangeSource,
	treeChangeSource
} from '@justfiles/fs/sync-replica'
import { describe, expect, it } from 'vitest'
import { createSqliteAdapter } from './db.sqlite'
import { createFsApi } from './fs'
import { createFsClient, remoteSyncReplica } from './fs.client'
import { storage as sqliteStorage } from './storage.sqlite'

const migrationsDir = new URL('./migrations/', import.meta.url)
const migrations = readdirSync(migrationsDir)
	.filter((f) => f.endsWith('.sql'))
	.sort()
	.map((f) => readFileSync(new URL(f, migrationsDir), 'utf8'))

function open(applied = migrations.length) {
	const db = new DatabaseSync(':memory:')
	for (const sql of migrations.slice(0, applied)) db.exec(sql)
	return db
}

function bigIntSafe(db: DatabaseSync) {
	return {
		prepare(sql: string) {
			const stmt = db.prepare(sql)
			stmt.setReadBigInts(true)
			return stmt
		},
		exec: (sql: string) => db.exec(sql)
	} as unknown as Parameters<typeof createSqliteAdapter>[0]
}

const bytes = (s: string) => new TextEncoder().encode(s)
// A NUL byte makes inferText bail, so this routes to the blob store, not inline.
const binary = (marker: number) => new Uint8Array([marker, 0, 1, 2, 3, marker])

function journalPaths(db: DatabaseSync): Array<string | null> {
	return db
		.prepare('SELECT path FROM fs_path_journal ORDER BY seq')
		.all()
		.map((row) => (row as { path: string | null }).path)
}

function journalCount(db: DatabaseSync): number {
	return Number((db.prepare('SELECT COUNT(*) AS n FROM fs_path_journal').get() as { n: number }).n)
}

/** Seed `count` journal rows on ONE path — all but the last are superseded. */
function seedJournal(db: DatabaseSync, path: string, count: number): void {
	const insert = db.prepare(
		'INSERT INTO fs_path_journal(local_source, change_json, path) VALUES (NULL, ?, ?)'
	)
	for (let i = 0; i < count; i++)
		insert.run(JSON.stringify({ kind: 'delete', path, version: String(i + 1) }), path)
}

/** Seed `paths` distinct paths, `each` rows apiece, in a stable path order. */
function seedPaths(db: DatabaseSync, paths: number, each: number): void {
	for (let i = 0; i < paths; i++) seedJournal(db, `/f${String(i).padStart(4, '0')}.json`, each)
}

/** Where the prune's walk stopped — '' once a pass is over. */
function resumePath(db: DatabaseSync): string {
	const row = db.prepare('SELECT journal_coalesce_path AS p FROM fs_generation WHERE id = 1').get()
	return String((row as { p: string }).p)
}

/** Backdate every journal row past any retention window. */
function ageJournal(db: DatabaseSync): void {
	db.exec('UPDATE fs_path_journal SET at_ns = 1')
}

function makeStorage() {
	const db = open()
	const storage = sqliteStorage(createSqliteAdapter(bigIntSafe(db)))
	return { db, storage, vol: volume(storage) }
}

/**
 * The Durable Object's argument binding, faithfully: it stringifies every bigint
 * (apps/frieren/worker/db.do.ts `normalizeArgs`), because the DO's `sql.exec` does
 * not take them. A comparison against a TEXT-bound number is not the comparison it
 * looks like — an INTEGER sorts below every string when neither side carries column
 * affinity — so any predicate over a `*_ns` value must survive this shape.
 */
function makeDoLikeStorage() {
	const db = open()
	const real = createSqliteAdapter(bigIntSafe(db))
	const stringifyBigints = (args?: unknown[]) =>
		args?.map((arg) => (typeof arg === 'bigint' ? arg.toString() : arg)) as
			| Parameters<typeof real.query>[1]
			| undefined
	const doLike: typeof real = {
		query: (sql, args) => real.query(sql, stringifyBigints(args)),
		run: (sql, args) => real.run(sql, stringifyBigints(args)),
		transaction: (fn) => fn(doLike)
	}
	const storage = sqliteStorage(doLike)
	return { db, storage, vol: volume(storage) }
}

function prunedBelow(db: DatabaseSync): number {
	return Number(
		(
			db.prepare('SELECT journal_pruned_below AS floor FROM fs_generation').get() as {
				floor: number
			}
		).floor
	)
}

describe('0007_journal_path', () => {
	it('backfills the path of every row written before the column existed', () => {
		const db = open(6)
		const insert = db.prepare(
			'INSERT INTO fs_path_journal(local_source, change_json) VALUES (?, ?)'
		)
		insert.run(null, JSON.stringify({ kind: 'delete', path: '/gone.md', version: '2' }))
		insert.run('remote', JSON.stringify({ kind: 'put', path: '/kept.md', version: '3' }))

		db.exec(migrations[6])

		expect(journalPaths(db)).toEqual(['/gone.md', '/kept.md'])
	})
})

describe('sqlite journal prune', () => {
	it('journals the path as a column, not only inside change_json', async () => {
		const db = open()
		const vol = volume(sqliteStorage(createSqliteAdapter(bigIntSafe(db))))
		await vol.mkdir('/notes')
		await vol.writeFile('/notes/one.md', bytes('hello'))

		expect(journalPaths(db)).toEqual(['/notes', '/notes/one.md'])
	})

	it('walks a bounded window of paths, and resumes where it stopped', async () => {
		const db = open()
		const content = sqliteStorage(createSqliteAdapter(bigIntSafe(db))).caps?.content
		if (!content) throw new Error('sqlite must offer a content store')
		// 1200 paths with a superseded row each: more paths than one run's window.
		seedPaths(db, 1200, 2)

		const first = await content.gcUnreferenced()
		expect(first.done).toBe(false)
		expect(journalCount(db)).toBe(1400) // 1000 paths coalesced, 200 not yet reached
		expect(resumePath(db)).toBe('/f0999.json')

		const second = await content.gcUnreferenced()
		expect(second.done).toBe(true)
		expect(journalCount(db)).toBe(1200)
		expect(resumePath(db)).toBe('') // the pass is over; the next run starts a new one
	})

	it('reads only its window when there is nothing at all to discard', async () => {
		// The P1 on #442, and the steady state: bounding the DISCARDED rows bounds the
		// writes and not the reads, so a journal that is already coalesced — which has
		// no rows to discard — was read end to end, with an index lookup per row, on
		// every daily event. The window is what makes this run stop early.
		const db = open()
		const content = sqliteStorage(createSqliteAdapter(bigIntSafe(db))).caps?.content
		if (!content) throw new Error('sqlite must offer a content store')
		seedPaths(db, 1200, 1)

		expect((await content.gcUnreferenced()).done).toBe(false)
		expect(resumePath(db)).toBe('/f0999.json') // stopped at the window, not at the end
		expect(journalCount(db)).toBe(1200) // nothing to discard, and nothing discarded

		expect((await content.gcUnreferenced()).done).toBe(true)
		expect(journalCount(db)).toBe(1200)
	})

	it('coalesces one path in one delete, however many rows it holds', async () => {
		const db = open()
		const content = sqliteStorage(createSqliteAdapter(bigIntSafe(db))).caps?.content
		if (!content) throw new Error('sqlite must offer a content store')
		seedJournal(db, '/busy.json', 1200)

		expect((await content.gcUnreferenced()).done).toBe(true)
		expect(journalPaths(db)).toEqual(['/busy.json'])
	})

	it('keeps the newest row of every path, and touches nothing already coalesced', async () => {
		const db = open()
		const s = sqliteStorage(createSqliteAdapter(bigIntSafe(db)))
		const vol = volume(s)
		await vol.writeFile('/state.json', bytes('old'))
		await vol.writeFile('/other.json', bytes('other'))
		await vol.writeFile('/state.json', bytes('current'))

		// Nothing to reclaim: an overwrite already collects the superseded bytes inside
		// its own transaction, so the sweep is here for the journal and for orphans no
		// mutation could see (a lost claim's staged content).
		expect(await s.caps?.content?.gcUnreferenced()).toEqual({ reclaimed: 0, done: true })
		expect(journalPaths(db)).toEqual(['/other.json', '/state.json'])

		// A second run has nothing to do and must still report a drained sweep.
		expect(await s.caps?.content?.gcUnreferenced()).toEqual({ reclaimed: 0, done: true })
		expect(journalCount(db)).toBe(2)
	})

	it('collects no content until a pass over the journal finishes', async () => {
		// A throttle, not a barrier: the content scan reads all of `fs_contents`, and a
		// continuation wakes once a minute. What it is NOT is protection for a superseded
		// row's bytes — an overwrite drops those inline, before any sweep runs (#446).
		const db = open()
		const content = sqliteStorage(createSqliteAdapter(bigIntSafe(db))).caps?.content
		if (!content) throw new Error('sqlite must offer a content store')
		// Bytes no inode references — what a lost claim leaves behind.
		const orphaned = 'a'.repeat(64)
		await content.putByHash(orphaned, bytes('orphan'))
		seedPaths(db, 1200, 2)

		expect((await content.gcUnreferenced()).done).toBe(false)
		expect(await content.hasByHash(orphaned)).toBe(true)

		expect((await content.gcUnreferenced()).done).toBe(true)
		expect(await content.hasByHash(orphaned)).toBe(false)
	})
})

describe('sqlite tombstone sweep', () => {
	it('keeps a fresh tombstone, and moves no floor', async () => {
		const { db, storage, vol } = makeStorage()
		await vol.writeFile('/gone.md', bytes('gone'))
		await vol.rm('/gone.md')

		expect((await storage.caps?.content?.gcUnreferenced())?.done).toBe(true)

		expect(journalPaths(db)).toEqual(['/gone.md'])
		expect(prunedBelow(db)).toBe(0)
	})

	it('keeps a fresh tombstone on the Durable Object, where bigints bind as text', async () => {
		// Without an explicit CAST the horizon comparison is integer-vs-string, which is
		// always true — the window silently collapses to zero and the first daily run
		// takes every tombstone the volume has.
		const { db, storage, vol } = makeDoLikeStorage()
		await vol.writeFile('/gone.md', bytes('gone'))
		await vol.rm('/gone.md')

		await storage.caps?.content?.gcUnreferenced()

		expect(journalPaths(db)).toEqual(['/gone.md'])
		expect(prunedBelow(db)).toBe(0)
	})

	it('collects a tombstone past the window, and raises the floor to it', async () => {
		const { db, storage, vol } = makeStorage()
		await vol.writeFile('/gone.md', bytes('gone'))
		await vol.rm('/gone.md')
		await vol.writeFile('/here.md', bytes('here'))
		ageJournal(db)
		const deleteSeq = Number(
			(
				db.prepare("SELECT MAX(seq) AS seq FROM fs_path_journal WHERE path = '/gone.md'").get() as {
					seq: number
				}
			).seq
		)

		await storage.caps?.content?.gcUnreferenced()

		// The deleted path is gone from the journal; the live one is untouched.
		expect(journalPaths(db)).toEqual(['/here.md'])
		expect(prunedBelow(db)).toBe(deleteSeq)
		// `fs_path_version` still holds the tombstone — it is the authoritative set a
		// re-bootstrapping replica is served, and it is not what this sweep collects.
		expect(await storage.caps?.pathSnapshot?.tombstones('', 10)).toHaveLength(1)
	})

	it('never leaves a put behind when it takes the delete', async () => {
		// The resurrection bug this rule exists for: a path with put@n and delete@m that
		// loses only its delete coalesces back to the put, and the file returns from the
		// dead on every device that bootstraps afterwards.
		const { db, storage, vol } = makeStorage()
		await vol.writeFile('/gone.md', bytes('v1'))
		await vol.writeFile('/gone.md', bytes('v2'))
		await vol.rm('/gone.md')
		ageJournal(db)

		// Two runs: the first coalesces, the second (with nothing left to coalesce) sweeps.
		await storage.caps?.content?.gcUnreferenced()
		await storage.caps?.content?.gcUnreferenced()

		expect(journalPaths(db)).toEqual([])
	})

	it('leaves a resurrected path alone — it is live again', async () => {
		const { db, storage, vol } = makeStorage()
		await vol.writeFile('/back.md', bytes('first'))
		await vol.rm('/back.md')
		await vol.writeFile('/back.md', bytes('again'))
		ageJournal(db)

		await storage.caps?.content?.gcUnreferenced()
		await storage.caps?.content?.gcUnreferenced()

		expect(journalPaths(db)).toEqual(['/back.md'])
		expect(prunedBelow(db)).toBe(0)
	})
})

describe('sqlite pruned-cursor floor', () => {
	it('refuses a delta read from below the floor, and serves one at it', async () => {
		const { db, storage, vol } = makeStorage()
		await vol.writeFile('/gone.md', bytes('gone'))
		await vol.rm('/gone.md')
		await vol.writeFile('/here.md', bytes('here'))
		ageJournal(db)
		await storage.caps?.content?.gcUnreferenced()
		const floor = prunedBelow(db)
		expect(floor).toBeGreaterThan(0)
		const source = journaledChangeSource(storage)

		await expect(source.pathDeltas(String(floor - 1))).rejects.toBeInstanceOf(CursorPrunedError)
		// AT the floor the reader has already seen every collected row.
		expect((await source.pathDeltas(String(floor))).done).toBe(true)
	})

	it('hands a bootstrap a resume cursor its own next pull will accept', async () => {
		// The loop this prevents: collect a path deleted at a HIGH seq while a live path's
		// only row sits at a low one, and `MAX(seq)` falls under the floor — so every
		// bootstrap would hand back a cursor its next pull refuses, forever.
		const { db, storage, vol } = makeStorage()
		await vol.writeFile('/here.md', bytes('here')) // low seq, survives
		await vol.writeFile('/gone.md', bytes('gone'))
		await vol.rm('/gone.md') // high seq, collected
		ageJournal(db)
		await storage.caps?.content?.gcUnreferenced()
		expect(prunedBelow(db)).toBeGreaterThan(0)

		const scan = await treeChangeSource(storage).pathScan(undefined, { limit: 10 })

		expect(Number(scan.syncCursor)).toBeGreaterThanOrEqual(prunedBelow(db))
		await expect(journaledChangeSource(storage).pathDeltas(scan.syncCursor)).resolves.toMatchObject(
			{ done: true }
		)
	})

	it('answers a pruned cursor with 410, and the client raises it as a typed error', async () => {
		const { db, storage, vol } = makeStorage()
		await vol.writeFile('/gone.md', bytes('gone'))
		await vol.rm('/gone.md')
		ageJournal(db)
		await storage.caps?.content?.gcUnreferenced()
		const app = createFsApi(storage)

		const res = await app.request('/path/changes?cursor=0')
		expect(res.status).toBe(410)
		expect(await res.json()).toMatchObject({ error: 'cursor_pruned' })

		const client = createFsClient({
			baseUrl: 'http://prune.test',
			fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
				app.request(input as string, init)) as unknown as typeof fetch
		})
		await expect(
			remoteSyncReplica(client, { clientId: 'c1' }).pathDeltas('0')
		).rejects.toBeInstanceOf(CursorPrunedError)
	})
})

describe('sqlite blob deletes', () => {
	it('sends orphaned keys to the blob store in one batched call', async () => {
		const db = open()
		const objects = new Map<string, Uint8Array>()
		const deletes: Array<string | string[]> = []
		const blobStore = {
			put: async (key: string, data: Uint8Array) => {
				objects.set(key, data.slice())
				return null
			},
			get: async (key: string) => {
				const data = objects.get(key)
				return data ? { arrayBuffer: async () => data.buffer } : null
			},
			delete: async (keys: string | string[]) => {
				deletes.push(keys)
				for (const key of typeof keys === 'string' ? [keys] : keys) objects.delete(key)
			}
		}
		const content = sqliteStorage(createSqliteAdapter(bigIntSafe(db)), {
			blobStore: blobStore as unknown as NonNullable<
				Parameters<typeof sqliteStorage>[1]
			>['blobStore']
		}).caps?.content
		if (!content) throw new Error('sqlite must offer a content store')
		// Two orphans no inode references, both binary so they route to the blob store.
		await content.putByHash('a'.repeat(64), binary(1))
		await content.putByHash('b'.repeat(64), binary(2))
		expect(objects.size).toBe(2) // both really took the blob-store path

		await content.gcUnreferenced()

		// Two orphans, ONE round trip — R2 takes up to 1000 keys per call.
		expect(deletes).toHaveLength(1)
		expect([...(deletes[0] as string[])].sort()).toHaveLength(2)
		expect(objects.size).toBe(0)
	})
})
