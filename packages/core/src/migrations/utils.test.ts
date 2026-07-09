import { describe, expect, it } from 'vitest'
import { parseSqlStatements } from './utils'

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
