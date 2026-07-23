import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createSqliteAdapter } from '../db.sqlite'
import { migrateFromEntries, parseSqlStatements } from './utils'

function makeAdapter() {
	const raw = new DatabaseSync(':memory:')
	return createSqliteAdapter({
		prepare: (sql: string) => raw.prepare(sql),
		exec: (sql: string) => raw.exec(sql)
	} as unknown as Parameters<typeof createSqliteAdapter>[0])
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

describe('migrateFromEntries', () => {
	it('applies a migration once and records its version (re-run is a no-op)', async () => {
		const db = makeAdapter()
		await migrateFromEntries(db, [{ version: 1, sql: 'CREATE TABLE t (id INTEGER)' }])
		// Re-running the SAME entry must not re-execute (a second CREATE TABLE would throw).
		await migrateFromEntries(db, [{ version: 1, sql: 'CREATE TABLE t (id INTEGER)' }])
		const versions = (
			await db.query<{ version: number }>('SELECT version FROM schema_migrations')
		).map((r) => Number(r.version))
		expect(versions).toEqual([1])
	})

	// Restart-safety: a migration interrupted after some statements commit must roll back
	// wholesale, so the next startup re-runs it cleanly instead of failing on a duplicate
	// (e.g. ALTER TABLE ADD COLUMN) and blocking every later migration.
	it('rolls back a failed migration wholesale so it is safely resumable', async () => {
		const db = makeAdapter()
		// The 2nd statement fails (no such table); the 1st (CREATE TABLE t) must NOT persist.
		await expect(
			migrateFromEntries(db, [
				{ version: 1, sql: 'CREATE TABLE t (id INTEGER); INSERT INTO missing VALUES (1)' }
			])
		).rejects.toThrow()
		expect((await db.query('SELECT version FROM schema_migrations')).length).toBe(0) // version NOT recorded

		// Re-run with a corrected migration: succeeds because nothing from the failed attempt
		// lingers (no "table t already exists").
		await migrateFromEntries(db, [{ version: 1, sql: 'CREATE TABLE t (id INTEGER)' }])
		const versions = (
			await db.query<{ version: number }>('SELECT version FROM schema_migrations')
		).map((r) => Number(r.version))
		expect(versions).toEqual([1])
	})
})
