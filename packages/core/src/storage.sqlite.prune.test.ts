// The daily journal prune (#398): it is the only sweep that runs against a live
// production volume, inside ONE Durable Object event where `db.transaction` is a
// no-op wrapper — so both its cost per row and its total work per run are the
// subject here, not just its result.

import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { volume } from '@justfiles/fs'
import { describe, expect, it } from 'vitest'
import { createSqliteAdapter } from './db.sqlite'
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
