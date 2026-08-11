// The sync path index (#439 item 3, 0010_path_index.sql).
//
// `fs_path_index` is DERIVED state: it must agree with the tree after every
// mutation, and the filesystem must not depend on it. Both halves are tested here —
// the first because an index that drifts serves a file under the wrong name to the
// next device that bootstraps, the second because it is the whole reason this lives
// in its own table instead of as a column on `fs_dirents`.

import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { volume } from '@justfiles/fs'
import { describe, expect, it } from 'vitest'
import type { DbAdapter } from './db'
import { createSqliteAdapter } from './db.sqlite'
import { parseSqlStatements } from './migrations/utils'
import { resetVolume } from './reset'
import { storage as sqliteStorage } from './storage.sqlite'

const migrationsDir = new URL('./migrations/', import.meta.url)
const migrationFiles = readdirSync(migrationsDir)
	.filter((f) => f.endsWith('.sql'))
	.sort()

const sqlOf = (file: string) => readFileSync(new URL(file, migrationsDir), 'utf8')
const schema = migrationFiles.map(sqlOf).join('\n')

const adapterOf = (db: DatabaseSync) => {
	const db64 = {
		prepare(sql: string) {
			const stmt = db.prepare(sql)
			stmt.setReadBigInts(true)
			return stmt
		},
		exec: (sql: string) => db.exec(sql)
	}
	return createSqliteAdapter(db64 as unknown as Parameters<typeof createSqliteAdapter>[0])
}

/**
 * Strip the adapter's real BEGIN/COMMIT, leaving statements to run straight through
 * — the shape both Durable Object adapters ship (`transaction` is `await fn(adapter)`;
 * see apps/worker/src/worker/db.do.ts and apps/frieren/worker/db.do.ts). A mutation
 * that throws partway does not undo the statements before it, so any invariant that
 * a test asserts through a rollback is not an invariant in production.
 */
const withoutRollback = (adapter: DbAdapter): DbAdapter => ({
	query: adapter.query,
	run: adapter.run,
	transaction: async (fn) => {
		await fn(withoutRollback(adapter))
	}
})

function makeSqlite(opts?: { rollback?: boolean }) {
	const db = new DatabaseSync(':memory:')
	db.exec(schema)
	const adapter = adapterOf(db)
	const storage = sqliteStorage(opts?.rollback === false ? withoutRollback(adapter) : adapter)
	return { db, storage, vol: volume(storage) }
}

const bytes = (s: string) => new TextEncoder().encode(s)

/**
 * Where the index and the tree disagree — the invariant, stated as a query. The walk
 * is the one the readers used to do per page, and the FULL OUTER shape catches drift
 * in both directions: a path the tree has and the index lost, and one the index kept
 * after the tree dropped it.
 */
function disagreements(db: DatabaseSync): { path: unknown; indexed: unknown; walked: unknown }[] {
	return db
		.prepare(
			`WITH RECURSIVE tree(path, ino) AS (
				SELECT '/' || name, ino FROM fs_dirents WHERE dir_ino = '1'
				UNION ALL
				SELECT tree.path || '/' || child.name, child.ino
				FROM tree JOIN fs_dirents child ON child.dir_ino = tree.ino
			)
			SELECT idx.path AS path, idx.ino AS indexed, tree.ino AS walked
			FROM fs_path_index AS idx
			LEFT JOIN tree ON tree.path = idx.path
			WHERE idx.ino IS NOT tree.ino
			UNION ALL
			SELECT tree.path, idx.ino, tree.ino
			FROM tree
			LEFT JOIN fs_path_index AS idx ON idx.path = tree.path
			WHERE idx.ino IS NOT tree.ino`
		)
		.all() as { path: unknown; indexed: unknown; walked: unknown }[]
}

const indexedPaths = (db: DatabaseSync): string[] =>
	(db.prepare('SELECT path FROM fs_path_index ORDER BY path').all() as { path: unknown }[]).map(
		(row) => String(row.path)
	)

describe('fs_path_index', () => {
	it('agrees with the tree after creates, writes, moves and deletes', async () => {
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
		expect(indexedPaths(db)).toEqual(['/archive', '/archive/two.md', '/notes', '/top.md'])
	})

	it('moves every descendant when a directory is renamed', async () => {
		const { db, storage, vol } = makeSqlite()
		await vol.mkdir('/a')
		await vol.mkdir('/a/deep')
		await vol.writeFile('/a/deep/leaf.md', bytes('leaf'))
		// Siblings that bracket the subtree range without being in it: '-' sorts below
		// '/' and 'b' above '0'.
		await vol.writeFile('/a-sibling.md', bytes('sibling'))
		await vol.writeFile('/ab.md', bytes('ab'))

		await vol.rename('/a', '/z')

		expect(disagreements(db)).toEqual([])
		expect(indexedPaths(db)).toEqual([
			'/a-sibling.md',
			'/ab.md',
			'/z',
			'/z/deep',
			'/z/deep/leaf.md'
		])
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

	it('reindexes a rename that displaces an existing file', async () => {
		const { db, vol } = makeSqlite()
		await vol.writeFile('/from.md', bytes('from'))
		await vol.writeFile('/onto.md', bytes('onto'))

		await vol.rename('/from.md', '/onto.md')

		expect(disagreements(db)).toEqual([])
		expect(indexedPaths(db)).toEqual(['/onto.md'])
	})

	// Both adapter shapes, because the guard has to hold on the one that ships.
	for (const rollback of [true, false]) {
		it(`refuses to displace a non-empty dir, rollback: ${rollback}`, async () => {
			// `atomicMove` unindexes ONE path for the entry it displaces, so a displaced
			// directory must never still have children — otherwise they keep their rows in
			// `fs_path_index` with no parent to reach them, and `pathSnapshot.puts` serves
			// those detached paths to the next device that bootstraps. The tree walk it
			// replaced could not, because it started from the root.
			//
			// The dirents' `ON DELETE RESTRICT` is NOT that guarantee. It fires late —
			// after the destination's dirent and index row are already gone — so it only
			// looks like one on an adapter that can roll back. Neither shipping adapter
			// can: both DO adapters implement `transaction` as `await fn(adapter)`, leaning
			// on the Durable Object's implicit per-event commit. Run with `rollback: false`
			// this case reproduced the detached row before `atomicMove` learned to refuse
			// the move up front.
			const { db, storage, vol } = makeSqlite({ rollback })
			await vol.mkdir('/src')
			await vol.writeFile('/src/a.md', bytes('a'))
			await vol.mkdir('/dst')
			await vol.writeFile('/dst/child.md', bytes('child'))
			const before = indexedPaths(db)

			const error = await vol.rename('/src', '/dst').then(
				() => null,
				(e: Error) => e
			)

			// State first, message second: what makes this a bug is the detached row, not
			// the wording. Asserting the message up front would mask the difference between
			// the two adapters — both would fail on the wrong error string, and only this
			// order shows that `rollback: false` also leaves the volume corrupted.
			expect(disagreements(db)).toEqual([])
			expect(indexedPaths(db)).toEqual(before)
			const snapshot = storage.caps?.pathSnapshot
			if (!snapshot) throw new Error('sqlite must serve a tree snapshot')
			expect((await snapshot.puts('', 100)).map((c) => c.path)).toEqual(before)
			expect(error?.message).toMatch(/^ENOTEMPTY/)
		})
	}

	it('indexes the apply side too, including dirs it repairs into place', async () => {
		const { db, storage, vol } = makeSqlite()
		await vol.mkdir('/kept')
		const apply = storage.caps?.pathApply
		if (!apply) throw new Error('sqlite must apply journaled changes')

		// A pulled put whose parents do not exist yet: `ensureDirPath` creates them and
		// `setDirent` binds the leaf — the two writers on the sync side of the tree. The
		// repaired directories mint no version and get no journal row, which is why the
		// index follows the TREE rather than the journal.
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
		expect(indexedPaths(db)).toEqual(['/kept', '/pulled', '/pulled/deep', '/pulled/deep/file.md'])
	})

	it('is rebuilt by a reset, around whatever the reset kept', async () => {
		const { db, storage, vol } = makeSqlite()
		await vol.mkdir('/private')
		await vol.writeFile('/private/key.json', bytes('secret'))
		await vol.writeFile('/note.md', bytes('note'))

		// `adopt-mine` truncates the tree so the initiator can republish it, but keeps
		// the private subtrees no republish could restore. The index has to follow both
		// halves, which is why the reset rebuilds it from the tree rather than emptying
		// it like the journal beside it.
		const [{ lineage_id: lineageId }] = db
			.prepare('SELECT lineage_id FROM fs_generation WHERE id = 1')
			.all() as { lineage_id: string }[]
		const decision = await resetVolume(adapterOf(db), {
			mode: 'adopt-mine',
			fromGeneration: 1,
			operationId: 'r1',
			lineageId
		})
		expect(decision.ok).toBe(true)

		expect(disagreements(db)).toEqual([])
		expect(indexedPaths(db)).toEqual(['/private', '/private/key.json'])
		const snapshot = storage.caps?.pathSnapshot
		if (!snapshot) throw new Error('sqlite must serve a tree snapshot')
		expect((await snapshot.puts('', 100)).map((c) => c.path)).toEqual([
			'/private',
			'/private/key.json'
		])
	})

	it('is derived state: the filesystem works with the index emptied', async () => {
		const { db, storage, vol } = makeSqlite()
		await vol.mkdir('/notes')
		await vol.writeFile('/notes/one.md', bytes('one'))

		db.exec('DELETE FROM fs_path_index')

		// Every filesystem operation still answers. Only the sync snapshot goes quiet,
		// and the migration carries the walk that rebuilds it.
		expect(new TextDecoder().decode(await vol.readFile('/notes/one.md'))).toBe('one')
		expect((await vol.readdir('/notes')).map((e) => e.name)).toEqual(['one.md'])
		await vol.writeFile('/notes/two.md', bytes('two'))
		await vol.rename('/notes/two.md', '/notes/three.md')
		await vol.rm('/notes/three.md')
		expect((await vol.readdir('/notes')).map((e) => e.name)).toEqual(['one.md'])

		const snapshot = storage.caps?.pathSnapshot
		if (!snapshot) throw new Error('sqlite must serve a tree snapshot')
		expect(await snapshot.puts('', 100)).toEqual([])
	})
})

describe('0010_path_index', () => {
	it('backfills every path the walk reaches, and skips what it cannot', () => {
		// The database as it stood BEFORE this migration: every earlier migration, and a
		// tree written without an index.
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
		const statements = parseSqlStatements(sqlOf('0010_path_index.sql'))
		expect(statements).toHaveLength(2) // create the table, backfill it
		for (const statement of statements) db.exec(statement)

		expect(
			(db.prepare('SELECT path, ino FROM fs_path_index ORDER BY path').all() as unknown[]).map(
				(row) => row as { path: unknown; ino: unknown }
			)
		).toEqual([
			{ path: '/notes', ino: 'd1' },
			{ path: '/notes/one.md', ino: 'f1' }
		])
	})
})
