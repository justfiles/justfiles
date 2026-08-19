/**
 * The reset, in the store model and on the synchronous seam.
 *
 * What is new here is not the CAS — `reset.test.ts` already covers that decision,
 * and this shares it — but the two things the store model changed about applying
 * one: the tree it empties is a STORE, so the host's own `/private` is kept by not
 * being in it rather than by a walk that spares it; and the whole body is one
 * `transactionSync`, so a half-applied reset is not a state the database can be
 * left in.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { ForeignCursorError, type Node, ROOT } from '@justfiles/fs/store'
import { describe, expect, test } from 'vitest'
import type { SyncDb } from './db'
import { createSqliteSyncDb } from './db.sqlite'
import { readGenerationState, resetStore } from './reset'
import { sqliteStore } from './store.sqlite'

const migrationsDir = new URL('./migrations/', import.meta.url)
const schema = readdirSync(migrationsDir)
	.filter((f) => f.endsWith('.sql'))
	.sort()
	.map((f) => readFileSync(new URL(f, migrationsDir), 'utf8'))
	.join('\n')

/** The old schema too: the generation row this CASes on is a table of its own. */
const makeDb = (): SyncDb => {
	const raw = new DatabaseSync(':memory:')
	raw.exec(schema)
	const db64 = {
		prepare(sql: string) {
			const statement = raw.prepare(sql)
			statement.setReadBigInts(true)
			return statement
		},
		exec: (sql: string) => raw.exec(sql)
	}
	return createSqliteSyncDb(db64 as unknown as Parameters<typeof createSqliteSyncDb>[0])
}

/** `readGenerationState` reads through the async seam; this file writes through the sync one. */
const async = (db: SyncDb) => ({
	query: async <T extends Record<string, unknown>>(sql: string, args?: never) =>
		db.query<T>(sql, args),
	run: async () => {},
	transaction: async () => {}
})

const node = (over: Partial<Node> & Pick<Node, 'id' | 'name'>): Node => ({
	parent: ROOT,
	type: 'file',
	mode: 0o100644,
	mtimeNs: 0n,
	size: 0n,
	version: '1',
	...over
})

/**
 * A request that names the volume it is resetting. `decideReset` requires an
 * `adopt-mine` to carry the matching `lineageId` — the one guard that stops a
 * redirected client truncating a DIFFERENT volume at the same generation — and the
 * migration mints one, so every request here has to read it.
 */
const request = (db: SyncDb, over: Partial<Parameters<typeof resetStore>[1]> = {}) => {
	const [row] = db.query('SELECT lineage_id FROM fs_generation WHERE id = 1 LIMIT 1')
	return {
		mode: 'adopt-mine' as const,
		fromGeneration: 1,
		operationId: 'op-1',
		lineageId: row?.lineage_id == null ? undefined : String(row.lineage_id),
		...over
	}
}

describe('resetStore', () => {
	test('an adopt-mine empties the synced tree and leaves the bound store whole', async () => {
		const db = makeDb()
		await sqliteStore(db).commit([node({ id: 'a', name: 'a.txt' })])
		await sqliteStore(db, 'private').commit([node({ id: 'secret', name: 'accounts.json' })])

		const decision = resetStore(db, request(db), { local: ['private'] })

		expect(decision.ok).toBe(true)
		expect((await sqliteStore(db).since()).nodes.map((n) => n.id)).toEqual([ROOT])
		// The old model spared these with a walk (`privateInos`) because they were rows
		// in the tree it was truncating. Here they are another store, so nothing has to
		// remember to spare them — the reset was never pointed at them.
		expect((await sqliteStore(db, 'private').since()).nodes.map((n) => n.id)).toEqual([
			ROOT,
			'secret'
		])
		expect((await readGenerationState(async(db) as never)).generation).toBe(2)
	})

	test('a wipe empties the bound stores too, and their content with them', async () => {
		const db = makeDb()
		const secret = new TextEncoder().encode('token')
		const hash = 'f'.repeat(64)
		await sqliteStore(db, 'private').blobs.put(hash, secret)
		await sqliteStore(db, 'private').commit([node({ id: 'secret', name: 'accounts.json' })])

		resetStore(db, request(db, { mode: 'wipe' }), { local: ['private'] })

		expect((await sqliteStore(db, 'private').since()).nodes.map((n) => n.id)).toEqual([ROOT])
		// "Delete everything" must not leave the discarded bytes fetchable by hash.
		expect(await sqliteStore(db, 'private').blobs.has(hash)).toBe(false)
	})

	test('a stale generation changes nothing at all', async () => {
		const db = makeDb()
		await sqliteStore(db).commit([node({ id: 'a', name: 'a.txt' })])

		expect(resetStore(db, request(db, { fromGeneration: 7 }))).toEqual({
			ok: false,
			error: 'generation_stale',
			generation: 1
		})
		expect((await sqliteStore(db).since()).nodes.map((n) => n.id)).toEqual([ROOT, 'a'])
	})

	test('a replay is the same answer and not a second truncate', async () => {
		const db = makeDb()
		await sqliteStore(db).commit([node({ id: 'a', name: 'a.txt' })])
		resetStore(db, request(db))
		await sqliteStore(db).commit([node({ id: 'b', name: 'b.txt' })])

		// The operation already committed, so the tree it produced — and everything
		// written into it since — is what a repeat of the same request must leave.
		expect(resetStore(db, request(db))).toMatchObject({ ok: true, replayed: true })
		expect((await sqliteStore(db).since()).nodes.map((n) => n.id)).toContain('b')
	})

	test('the lineage is what tells the replicas: every cursor from before is fenced', async () => {
		const db = makeDb()
		const before = sqliteStore(db)
		await before.commit([node({ id: 'a', name: 'a.txt' })])
		const { next: cursor } = await before.since()
		if (!cursor) throw new Error('since must always hand a cursor back')

		resetStore(db, request(db))

		await expect(sqliteStore(db).since(cursor)).rejects.toThrow(ForeignCursorError)
	})

	test('the CAS and the empty are ONE transaction: a failure leaves neither', async () => {
		const db = makeDb()
		await sqliteStore(db).commit([node({ id: 'a', name: 'a.txt' })])
		// The generation write is the last statement in the body, so failing it is how
		// a reset stops after the tree is gone — the exact half-applied state an
		// `await fn(adapter)` "transaction" would leave behind on a Durable Object.
		const broken: SyncDb = {
			...db,
			exec: (sql, args) => {
				if (sql.includes('fs_generation')) throw new Error('disk full')
				db.exec(sql, args)
			}
		}

		expect(() => resetStore(broken, request(db))).toThrow('disk full')
		expect((await sqliteStore(db).since()).nodes.map((n) => n.id)).toEqual([ROOT, 'a'])
		expect((await readGenerationState(async(db) as never)).generation).toBe(1)
	})
})
