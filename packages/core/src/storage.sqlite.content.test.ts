// Unit test for the SQLite backend's hash-addressed `caps.content` — the blob
// store the path-sync SyncReplica reads/writes to materialise pulled content
// out-of-band. Runs under vitest via node's built-in node:sqlite (no bun); see
// storage.sqlite.conformance.test.ts for the same DbAdapter shim rationale.

import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { createSqliteAdapter } from './db.sqlite'
import { storage as sqliteStorage } from './storage.sqlite'

const schema = readFileSync(new URL('./migrations/0001_schema.sql', import.meta.url), 'utf8')

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
	return sqliteStorage(
		createSqliteAdapter(db64 as unknown as Parameters<typeof createSqliteAdapter>[0])
	)
}

const bytes = (s: string) => new TextEncoder().encode(s)
const text = (b: Uint8Array) => new TextDecoder().decode(b)

describe('sqlite caps.content (hash-addressed blob store)', () => {
	let content: NonNullable<ReturnType<typeof sqliteStorage>['caps']>['content']
	beforeEach(() => {
		content = makeSqlite().caps?.content
	})

	it('exposes the content cap', () => {
		expect(content).toBeDefined()
	})

	it('round-trips a blob by hash', async () => {
		const hash = 'a'.repeat(64)
		await content!.putByHash(hash, bytes('hello world'))
		expect(text((await content!.getByHash(hash))!)).toBe('hello world')
	})

	it('reports presence by hash', async () => {
		const hash = 'b'.repeat(64)
		expect(await content!.hasByHash(hash)).toBe(false)
		await content!.putByHash(hash, bytes('data'))
		expect(await content!.hasByHash(hash)).toBe(true)
	})

	it('returns null for an absent hash', async () => {
		expect(await content!.getByHash('c'.repeat(64))).toBeNull()
	})

	it('is idempotent — re-putting the same hash keeps the content', async () => {
		const hash = 'd'.repeat(64)
		await content!.putByHash(hash, bytes('once'))
		await content!.putByHash(hash, bytes('once'))
		expect(text((await content!.getByHash(hash))!)).toBe('once')
	})
})
