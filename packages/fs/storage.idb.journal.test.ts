/**
 * The IDB journal's one-row-per-path rule (#439), on the side the shared
 * conformance suite cannot reach: the UPGRADE.
 *
 * A shipping profile carries a journal written before that rule, so the version-6
 * upgrade builds the `by-path` index and collapses the backlog once. That runs in a
 * version-change transaction, from an async callback — the fragile part, and the one
 * that only ever executes on a database that already has rows in it.
 *
 * `fake-indexeddb/auto` MUST be imported before `storage.idb` (its module-load
 * `IDBKeyRange` capture reads the global).
 */

import 'fake-indexeddb/auto'
import { openDB } from 'idb'
import { describe, expect, it } from 'vitest'
import { idbStorage } from './storage.idb'
import type { PathChange } from './sync-wire'
import { FileType } from './types'
import { volume } from './volume'

/** Distinct wire-shaped hashes: the assertions turn on WHICH row survived. */
const hash = (n: number): string => String(n).padStart(64, '0')

const put = (path: string, version: number): PathChange => ({
	kind: 'put',
	path,
	version: String(version),
	contentHash: hash(version),
	meta: { type: FileType.Regular, mode: 0o644, mtimeNs: '0', size: '1' }
})

/** The v5 database exactly as `DB_VERSION = 5` created it — stores, indexes, rows. */
async function seedV5(name: string, rows: PathChange[]): Promise<void> {
	const db = await openDB(name, 5, {
		upgrade(db) {
			db.createObjectStore('inodes', { keyPath: 'ino' })
			const content = db.createObjectStore('content', { keyPath: 'contentHash' })
			content.createIndex('by-lru', 'lastAccessedAt')
			const dirs = db.createObjectStore('dirs', { keyPath: ['dirIno', 'name'] })
			dirs.createIndex('by-dir', 'dirIno')
			dirs.createIndex('by-ino', 'ino')
			const xattrs = db.createObjectStore('xattrs', { keyPath: ['ino', 'name'] })
			xattrs.createIndex('by-ino', 'ino')
			db.createObjectStore('dirty', { keyPath: 'ino' })
			db.createObjectStore('meta')
			db.createObjectStore('journal', { keyPath: 'seq', autoIncrement: true })
			db.createObjectStore('pathver', { keyPath: 'path' })
		}
	})
	for (const change of rows) await db.add('journal', { change } as never)
	db.close()
}

describe('idbStorage journal upgrade', () => {
	it('collapses a v5 backlog to the newest row per path, and keeps its seq', async () => {
		const name = `journal-${crypto.randomUUID()}`
		await seedV5(name, [put('/a.txt', 1), put('/b.txt', 1), put('/a.txt', 2), put('/a.txt', 3)])

		const storage = idbStorage(name)
		const journal = storage.caps?.journal
		if (!journal) throw new Error('backend exposes no path journal')
		const rows = await journal.readFrom(0, 100)

		expect(rows.map((row) => row.change.path)).toEqual(['/b.txt', '/a.txt'])
		expect(rows.at(-1)?.change).toMatchObject({ version: '3', contentHash: hash(3) })
		// The surviving row keeps the seq it was written at — a reader's cursor sits in
		// this sequence, so compaction must not renumber underneath it.
		expect(rows.at(-1)?.seq).toBe(4)
		expect(await journal.head()).toBe(4)
	})

	it('leaves an already-compact journal alone, and coalesces what comes after', async () => {
		const name = `journal-${crypto.randomUUID()}`
		await seedV5(name, [put('/a.txt', 1)])

		const storage = idbStorage(name)
		const journal = storage.caps?.journal
		if (!journal) throw new Error('backend exposes no path journal')
		expect(await journal.readFrom(0, 100)).toHaveLength(1)

		// The index the upgrade built is the one the write path uses, so a write over
		// the migrated row must supersede it rather than pile on.
		const vol = volume(storage)
		await vol.writeFile('/a.txt', new TextEncoder().encode('current'))
		await vol.writeFile('/a.txt', new TextEncoder().encode('newer'))

		const rows = await journal.readFrom(0, 100)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.change.path).toBe('/a.txt')
		expect(rows[0]?.change).not.toMatchObject({ contentHash: hash(1) })
	})
})
