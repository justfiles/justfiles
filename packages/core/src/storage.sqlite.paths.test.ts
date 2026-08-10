// The materialised dirent path (#439 item 3, 0010_dirent_path.sql).
//
// `fs_dirents.path` is now the answer to "where is this entry?", so these tests hold
// it to the walk it replaced: after every mutation the stored path must equal the
// path a recursive walk from the root would build. A writer that forgets to set it,
// or a rename that leaves a descendant behind, shows up here rather than as a file
// served under the wrong name to the next device that bootstraps.

import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { volume } from '@justfiles/fs'
import { describe, expect, it } from 'vitest'
import { createSqliteAdapter } from './db.sqlite'
import { parseSqlStatements } from './migrations/utils'
import { storage as sqliteStorage } from './storage.sqlite'

const migrationsDir = new URL('./migrations/', import.meta.url)
const migrationFiles = readdirSync(migrationsDir)
	.filter((f) => f.endsWith('.sql'))
	.sort()

const sqlOf = (file: string) => readFileSync(new URL(file, migrationsDir), 'utf8')
const schema = migrationFiles.map(sqlOf).join('\n')

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

/**
 * Entries whose stored path disagrees with the walk — the invariant, stated as a
 * query. `IS NOT` rather than `<>` so an entry the walk cannot reach (NULL on both
 * sides) counts as agreement.
 */
function disagreements(db: DatabaseSync): { name: unknown; stored: unknown; walked: unknown }[] {
	return db
		.prepare(
			`WITH RECURSIVE tree(path, ino, dir_ino, name) AS (
				SELECT '/' || name, ino, dir_ino, name FROM fs_dirents WHERE dir_ino = '1'
				UNION ALL
				SELECT tree.path || '/' || child.name, child.ino, child.dir_ino, child.name
				FROM tree JOIN fs_dirents child ON child.dir_ino = tree.ino
			)
			SELECT dirent.name AS name, dirent.path AS stored, tree.path AS walked
			FROM fs_dirents AS dirent
			LEFT JOIN tree ON tree.dir_ino = dirent.dir_ino AND tree.name = dirent.name
			WHERE dirent.path IS NOT tree.path`
		)
		.all() as { name: unknown; stored: unknown; walked: unknown }[]
}

const storedPaths = (db: DatabaseSync): string[] =>
	(db.prepare('SELECT path FROM fs_dirents ORDER BY path').all() as { path: unknown }[]).map(
		(row) => String(row.path)
	)

describe('fs_dirents.path', () => {
	it('matches the walk after creates, writes, moves and deletes', async () => {
		const { db, vol } = makeSqlite()
		await vol.mkdir('/notes')
		await vol.mkdir('/notes/2026')
		await vol.writeFile('/notes/2026/one.md', bytes('one'))
		await vol.writeFile('/top.md', bytes('top'))
		await vol.symlink('/notes/2026/one.md', '/link.md')
		expect(disagreements(db)).toEqual([])

		await vol.rename('/notes/2026', '/archive')
		await vol.writeFile('/archive/two.md', bytes('two'))
		expect(disagreements(db)).toEqual([])

		await vol.rm('/archive/one.md')
		await vol.rm('/link.md')
		expect(disagreements(db)).toEqual([])
		expect(storedPaths(db)).toEqual(['/archive', '/archive/two.md', '/notes', '/top.md'])
	})

	it('moves every descendant path when a directory is renamed', async () => {
		const { db, storage, vol } = makeSqlite()
		await vol.mkdir('/a')
		await vol.mkdir('/a/deep')
		await vol.writeFile('/a/deep/leaf.md', bytes('leaf'))
		// A sibling whose name only just misses the subtree range: '-' sorts below '/'
		// and 'b' above '0', so both bracket the descendants without being in them.
		await vol.writeFile('/a-sibling.md', bytes('sibling'))
		await vol.writeFile('/ab.md', bytes('ab'))

		await vol.rename('/a', '/z')

		expect(disagreements(db)).toEqual([])
		expect(storedPaths(db)).toEqual(['/a-sibling.md', '/ab.md', '/z', '/z/deep', '/z/deep/leaf.md'])
		// The snapshot a bootstrapping device pages through reads those same rows.
		const snapshot = storage.caps?.pathSnapshot
		if (!snapshot) throw new Error('sqlite must serve a tree snapshot')
		expect((await snapshot.puts('', 100)).map((c) => c.path)).toEqual([
			'/a-sibling.md',
			'/ab.md',
			'/z',
			'/z/deep',
			'/z/deep/leaf.md'
		])
	})

	it('journals a write under the moved path, not the one it was created at', async () => {
		const { storage, vol } = makeSqlite()
		await vol.mkdir('/a')
		await vol.writeFile('/a/note.md', bytes('one'))
		await vol.rename('/a', '/b')

		await vol.writeFile('/b/note.md', bytes('two'))

		const journal = storage.caps?.journal
		if (!journal) throw new Error('sqlite must expose a journal')
		const rows = await journal.readFrom(0, 100)
		expect(rows.at(-1)?.change.path).toBe('/b/note.md')
	})

	it('fills the path on the apply side too, including dirs it repairs into place', async () => {
		const { db, storage, vol } = makeSqlite()
		await vol.mkdir('/kept')
		const apply = storage.caps?.pathApply
		if (!apply) throw new Error('sqlite must apply journaled changes')

		// A pulled put whose parents do not exist yet: `ensureDirPath` creates them, and
		// `setDirent` binds the leaf — the two writers on the sync side of the tree.
		await apply.applyJournaled(
			[
				{
					kind: 'put',
					path: '/pulled/deep/file.md',
					version: '4',
					source: 'peer',
					contentHash: 'a'.repeat(64),
					meta: { type: 0, mode: 0o644, mtimeNs: '7', size: '3' }
				}
			],
			{ localSource: 'remote' }
		)

		expect(disagreements(db)).toEqual([])
		expect(storedPaths(db)).toEqual(['/kept', '/pulled', '/pulled/deep', '/pulled/deep/file.md'])
		const snapshot = storage.caps?.pathSnapshot
		if (!snapshot) throw new Error('sqlite must serve a tree snapshot')
		expect((await snapshot.puts('', 100)).map((c) => c.path)).toEqual([
			'/kept',
			'/pulled',
			'/pulled/deep',
			'/pulled/deep/file.md'
		])
	})

	it('pages the scan by canonical path, resuming from the cursor it returned', async () => {
		const { storage, vol } = makeSqlite()
		await vol.mkdir('/notes')
		await vol.writeFile('/notes/one.md', bytes('one'))
		await vol.writeFile('/top.md', bytes('top'))
		const scan = storage.caps?.fullScan
		if (!scan) throw new Error('sqlite must serve a full scan')

		const all = await scan('')
		expect(all.entries.map((e) => e.name)).toEqual(['notes', 'one.md', 'top.md'])
		expect(all.next).toBe('')
		// The cursor is a canonical path, and resuming from one mid-tree returns the
		// rest — parent before child, which is what the VFS walk resolves names by.
		expect((await scan('/notes')).entries.map((e) => e.name)).toEqual(['one.md', 'top.md'])
	})
})

describe('0010_dirent_path backfill', () => {
	it('fills every entry the walk reaches, and leaves an unreachable one NULL', () => {
		// The database as it stood BEFORE this migration: every earlier migration, and
		// dirents written without a path.
		const db = new DatabaseSync(':memory:')
		db.exec(
			migrationFiles
				.filter((f) => !f.startsWith('0010'))
				.map(sqlOf)
				.join('\n')
		)
		const inode = (ino: string, type: number) =>
			db
				.prepare(
					`INSERT INTO fs_inodes(ino, type, mode, size, mtime_ns, ctime_ns, storage_kind)
					 VALUES (?, ?, 420, 0, 0, 0, 0)`
				)
				.run(ino, type)
		const dirent = (dirIno: string, name: string, ino: string, type: number) =>
			db
				.prepare('INSERT INTO fs_dirents(dir_ino, name, ino, type) VALUES (?, ?, ?, ?)')
				.run(dirIno, name, ino, type)
		inode('1', 1)
		inode('d1', 1)
		inode('f1', 0)
		inode('detached', 1)
		inode('f2', 0)
		dirent('1', 'notes', 'd1', 1)
		dirent('d1', 'one.md', 'f1', 0)
		// A directory with no entry of its own: nothing reaches its child from the root.
		dirent('detached', 'ghost.md', 'f2', 0)

		// Statement by statement, the way the Durable Object applies it — a migration
		// this one's prose split wrongly would run there and not here.
		const statements = parseSqlStatements(sqlOf('0010_dirent_path.sql'))
		expect(statements).toHaveLength(3) // add the column, backfill it, index it
		for (const statement of statements) db.exec(statement)

		const rows = db.prepare('SELECT name, path FROM fs_dirents ORDER BY name').all() as {
			name: unknown
			path: unknown
		}[]
		expect(rows).toEqual([
			{ name: 'ghost.md', path: null },
			{ name: 'notes', path: '/notes' },
			{ name: 'one.md', path: '/notes/one.md' }
		])
	})
})
