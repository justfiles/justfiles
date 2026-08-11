// What the journal is allowed to SERVE (#446).
//
// This backend drops a superseded `contentHash` inline, in the same transaction as
// the overwrite. So any older journal row that still names those bytes is a put no
// client can hydrate. `pathDeltas` coalesces each page by path and normally hides
// such a row behind its successor — but only within ONE page, and a page cut between
// the two serves the stale row alone.
//
// The fix is to keep at most one row per path at all times, so the stale row does not
// exist to be cut around. These tests hold the journal to that.

import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { volume } from '@justfiles/fs'
import type { JournaledStorage } from '@justfiles/sync/replica'
import { journaledChangeSource } from '@justfiles/sync/replica'
import { describe, expect, it } from 'vitest'
import { createSqliteAdapter } from './db.sqlite'
import { storage as sqliteStorage } from './storage.sqlite'

const migrationsDir = new URL('./migrations/', import.meta.url)
const schema = readdirSync(migrationsDir)
	.filter((f) => f.endsWith('.sql'))
	.sort()
	.map((f) => readFileSync(new URL(f, migrationsDir), 'utf8'))
	.join('\n')

function make() {
	const db = new DatabaseSync(':memory:')
	db.exec(schema)
	const bigIntSafe = {
		prepare(sql: string) {
			const stmt = db.prepare(sql)
			stmt.setReadBigInts(true)
			return stmt
		},
		exec: (sql: string) => db.exec(sql)
	}
	const storage = sqliteStorage(
		createSqliteAdapter(bigIntSafe as unknown as Parameters<typeof createSqliteAdapter>[0])
	)
	return { db, storage, vol: volume(storage) }
}

const bytes = (s: string) => new TextEncoder().encode(s)

function journalRows(db: DatabaseSync): Array<{ seq: number; path: string }> {
	return db
		.prepare('SELECT seq, path FROM fs_path_journal ORDER BY seq')
		.all()
		.map((row) => {
			const r = row as { seq: number | bigint; path: string }
			return { seq: Number(r.seq), path: r.path }
		})
}

/** Every contentHash the journal hands out, draining the deltas at this page size. */
async function hashesServedAtPageSize(storage: JournaledStorage, limit: number): Promise<string[]> {
	const source = journaledChangeSource(storage.sync)
	const served: string[] = []
	let cursor = '0'
	for (;;) {
		const page = await source.pathDeltas(cursor, { limit })
		for (const change of page.changes)
			if (change.kind === 'put' && change.contentHash) served.push(change.contentHash)
		cursor = page.to
		if (page.done) return served
	}
}

describe('sqlite journal: one row per path', () => {
	it('keeps only the newest row when a path is written again', async () => {
		const { db, vol } = make()
		await vol.writeFile('/state.json', bytes('v1'))
		await vol.writeFile('/state.json', bytes('v2'))
		await vol.writeFile('/state.json', bytes('v3'))

		expect(journalRows(db).map((r) => r.path)).toEqual(['/state.json'])
	})

	it('keeps the NEW row, not the old one — the insert lands before the delete', async () => {
		const { db, storage, vol } = make()
		await vol.writeFile('/state.json', bytes('v1'))
		const [first] = journalRows(db)
		await vol.writeFile('/state.json', bytes('v2'))

		const [only] = journalRows(db)
		expect(only?.seq).toBeGreaterThan(first?.seq ?? 0)
		// And it names the CURRENT bytes, which the volume can still serve.
		const current = String((await vol.stat('/state.json')).contentHash)
		expect(await storage.caps?.content?.hasByHash(current)).toBe(true)
	})

	it('collapses a delete onto its put, and a recreate onto its delete', async () => {
		const { db, vol } = make()
		await vol.writeFile('/gone.md', bytes('here'))
		await vol.rm('/gone.md')
		expect(journalRows(db).map((r) => r.path)).toEqual(['/gone.md'])

		await vol.writeFile('/gone.md', bytes('back'))
		expect(journalRows(db).map((r) => r.path)).toEqual(['/gone.md'])
	})

	it('holds one row per path when the sync layer applies a remote change', async () => {
		const { db, storage } = make()
		const journal = storage.sync.journal
		if (!journal) throw new Error('sqlite must expose a path journal')
		const remote = (version: string) =>
			({
				kind: 'delete' as const,
				path: '/from-peer.md',
				version,
				source: 'peer'
			}) satisfies Parameters<typeof journal.append>[0][number]

		await journal.append([remote('1')], 'remote')
		await journal.append([remote('2')], 'remote')

		expect(journalRows(db).map((r) => r.path)).toEqual(['/from-peer.md'])
	})
})

describe('sqlite journal: what a delta page may name', () => {
	it('never serves a put whose bytes the overwrite already dropped', async () => {
		const { storage, vol } = make()
		await vol.writeFile('/p.md', bytes('v1'))
		const stale = String((await vol.stat('/p.md')).contentHash)
		await vol.writeFile('/filler-a.md', bytes('a'))
		await vol.writeFile('/filler-b.md', bytes('b'))
		await vol.writeFile('/p.md', bytes('v2'))

		// The bytes go the moment the overwrite commits. That part is by design.
		expect(await storage.caps?.content?.hasByHash(stale)).toBe(false)

		// So no page, cut anywhere, may still name them.
		for (const limit of [1, 2, 3, 4, 10])
			expect(await hashesServedAtPageSize(storage, limit)).not.toContain(stale)
	})

	it('serves only hashes the volume can hydrate, at every page size', async () => {
		const { storage, vol } = make()
		await vol.mkdir('/notes')
		for (const round of ['one', 'two', 'three']) {
			await vol.writeFile('/notes/a.md', bytes(`a-${round}`))
			await vol.writeFile('/notes/b.md', bytes(`b-${round}`))
			await vol.writeFile('/top.md', bytes(`top-${round}`))
		}
		await vol.rm('/notes/b.md')
		// Collect what nothing references, exactly as the daily sweep does.
		await storage.caps?.content?.gcUnreferenced()
		// Then write AGAIN: rows the prune has not seen yet are the state a client
		// actually pulls in, so the invariant has to hold without a sweep behind it.
		await vol.writeFile('/top.md', bytes('top-final'))
		await vol.writeFile('/notes/a.md', bytes('a-final'))

		for (const limit of [1, 2, 5, 100]) {
			const served = await hashesServedAtPageSize(storage, limit)
			expect(served.length).toBeGreaterThan(0)
			for (const hash of served) expect(await storage.caps?.content?.hasByHash(hash)).toBe(true)
		}
	})

	it('still advances the cursor one row at a time', async () => {
		const { storage, vol } = make()
		for (const name of ['a', 'b', 'c']) await vol.writeFile(`/${name}.md`, bytes(name))
		const source = journaledChangeSource(storage.sync)

		const paths: string[] = []
		let cursor = '0'
		let pages = 0
		for (;;) {
			const page = await source.pathDeltas(cursor, { limit: 1 })
			pages++
			paths.push(...page.changes.map((c) => c.path))
			// A page that found rows must move the cursor, or the pull loops forever.
			if (!page.done) expect(page.to).not.toBe(cursor)
			cursor = page.to
			if (page.done) break
		}

		expect(paths).toEqual(['/a.md', '/b.md', '/c.md'])
		expect(pages).toBe(4) // three rows, then the short page that says done
	})
})
