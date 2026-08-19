import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { migrateSync, parseSqlStatements, type SyncMigrator } from './utils'

// A SyncMigrator over node:sqlite with a real BEGIN/COMMIT transaction — the same
// atomicity the DO gets from `storage.transactionSync`.
function makeSyncMigrator(): SyncMigrator & { raw: DatabaseSync } {
	const raw = new DatabaseSync(':memory:')
	return {
		raw,
		exec: (sql, args = []) => {
			raw.prepare(sql).run(...(args as Array<null | string | number | bigint | Uint8Array>))
		},
		query: (sql) => raw.prepare(sql).all() as Array<Record<string, unknown>>,
		transactionSync: (fn) => {
			raw.exec('BEGIN')
			try {
				fn()
				raw.exec('COMMIT')
			} catch (e) {
				raw.exec('ROLLBACK')
				throw e
			}
		}
	}
}

describe('parseSqlStatements', () => {
	it('splits top-level statements on semicolons', () => {
		expect(parseSqlStatements('CREATE TABLE a(x);\nCREATE TABLE b(y);')).toEqual([
			'CREATE TABLE a(x)',
			'CREATE TABLE b(y)'
		])
	})

	it('does not treat BEGIN/END substrings inside words as trigger tokens', () => {
		// "backend"/"append" contain end/…; a naive matcher flips the depth counter
		// and merges the two statements (the 0002_path_sync.sql regression).
		const sql = `-- the backend appends to this log
CREATE TABLE a(x);
-- the append-only backend log
CREATE TABLE b(y);`
		expect(parseSqlStatements(sql)).toEqual(['CREATE TABLE a(x)', 'CREATE TABLE b(y)'])
	})

	it('ignores semicolons inside line comments', () => {
		const sql = `CREATE TABLE a(x); -- note; with; semicolons
CREATE TABLE b(y);`
		expect(parseSqlStatements(sql)).toEqual(['CREATE TABLE a(x)', 'CREATE TABLE b(y)'])
	})

	it('yields nothing for a trailing comment block, newline or not', () => {
		// A file that ends in prose. Without this the tail is handed to the runner as
		// a statement, and the migration fails on a note about what it just did.
		const sql = 'CREATE TABLE a(x);\n-- what this left alone, and why\n-- the last word'
		expect(parseSqlStatements(sql)).toEqual(['CREATE TABLE a(x)'])
		expect(parseSqlStatements(`${sql}\n`)).toEqual(['CREATE TABLE a(x)'])
	})

	it('keeps a BEGIN…END trigger body as a single statement', () => {
		const sql = `CREATE TRIGGER t AFTER INSERT ON a BEGIN
	UPDATE a SET x = 1;
	DELETE FROM a WHERE x = 0;
END;
CREATE TABLE b(y);`
		const stmts = parseSqlStatements(sql)
		expect(stmts).toHaveLength(2)
		expect(stmts[0]).toContain('CREATE TRIGGER')
		expect(stmts[0]).toContain('END')
		expect(stmts[1]).toBe('CREATE TABLE b(y)')
	})
})

describe('migrateSync', () => {
	it('applies a migration once and records its version (re-run is a no-op)', () => {
		const db = makeSyncMigrator()
		migrateSync(db, [{ version: 1, sql: 'CREATE TABLE t (id INTEGER)' }])
		// Re-running the SAME entry must not re-execute (a second CREATE TABLE would throw).
		migrateSync(db, [{ version: 1, sql: 'CREATE TABLE t (id INTEGER)' }])
		const versions = db.query('SELECT version FROM schema_migrations').map((r) => Number(r.version))
		expect(versions).toEqual([1])
	})

	// Restart-safety: a migration interrupted after some statements commit must roll back
	// wholesale, so the next startup re-runs it cleanly instead of failing on a duplicate
	// (e.g. ALTER TABLE ADD COLUMN) and blocking every later migration.
	it('rolls back a failed migration wholesale so it is safely resumable', () => {
		const db = makeSyncMigrator()
		// The 2nd statement fails (no such table); the 1st (CREATE TABLE t) must NOT persist.
		expect(() =>
			migrateSync(db, [
				{ version: 1, sql: 'CREATE TABLE t (id INTEGER); INSERT INTO missing VALUES (1)' }
			])
		).toThrow()
		expect(db.query('SELECT version FROM schema_migrations').length).toBe(0) // version NOT recorded

		// Re-run with a corrected migration: succeeds because nothing from the failed attempt
		// lingers (no "table t already exists").
		migrateSync(db, [{ version: 1, sql: 'CREATE TABLE t (id INTEGER)' }])
		const versions = db.query('SELECT version FROM schema_migrations').map((r) => Number(r.version))
		expect(versions).toEqual([1])
	})

	/**
	 * The one thing the whole history has to get right: a volume at ANY applied level
	 * reaches the same schema as a fresh one. That is what makes 0012 a new migration
	 * instead of an edit to the files that created what it drops.
	 */
	it('lands on one schema from a fresh database and from every prior level', () => {
		const directory = new URL('./', import.meta.url)
		const migrations = readdirSync(directory)
			.filter((file) => /^\d+.*\.sql$/.test(file))
			.sort()
			.map((file, index) => ({
				version: index + 1,
				sql: readFileSync(new URL(file, directory), 'utf8')
			}))
		for (let applied = 0; applied < migrations.length; applied++) {
			const db = makeSyncMigrator()
			migrateSync(db, migrations.slice(0, applied))
			migrateSync(db, migrations)
			const tables = new Set(
				db
					.query("SELECT name FROM sqlite_master WHERE type = 'table'")
					.map((row) => String(row.name))
			)
			// What the one pass reads (migrate.sqlite.ts). It runs on a volume's first
			// boot after the swap, so these outlive the engine that wrote them.
			for (const table of ['fs_inodes', 'fs_dirents', 'fs_xattrs', 'fs_contents', 'fs_sync_nodes'])
				expect(tables.has(table)).toBe(true)
			// The old sync engine's own bookkeeping, retired by 0012.
			for (const table of [
				'fs_path_journal',
				'fs_path_version',
				'fs_node_journal',
				'fs_node_journal_mutations',
				'fs_node_clock',
				'fs_node_operations',
				'fs_content_fts'
			])
				expect(tables.has(table)).toBe(false)
			// The lineage row keeps its live columns and loses the prune's two bookmarks.
			const columns = new Set(
				db.query("SELECT name FROM pragma_table_info('fs_generation')").map((r) => String(r.name))
			)
			expect(columns.has('lineage_id')).toBe(true)
			expect(columns.has('journal_coalesce_path')).toBe(false)
			expect(columns.has('journal_pruned_below')).toBe(false)
			db.raw.close()
		}
	})
})
