// Volume reset (docs/sync-reset-generation.md). The pure CAS decision plus the
// transactional reset/clear bodies, driven against a REAL BEGIN/COMMIT adapter
// over node:sqlite — the same transport the sqlite conformance suite uses, so the
// reset-atomicity code path runs under vitest with no bun / Cloudflare runtime.
//
// The take-mine republish rides ordinary sync (no publishing lock, no finalize),
// so this file covers only the server-side reset primitives; the client-side
// resume/adopt/republish logic lives in packages/fs/synced.test.ts.

import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { volume } from '@justfiles/fs'
import { describe, expect, it } from 'vitest'
import type { DbAdapter } from './db'
import { createSqliteAdapter } from './db.sqlite'
import {
	clearReset,
	decideReset,
	type GenerationState,
	readGenerationState,
	resetVolume
} from './reset'
import { storage as sqliteStorage } from './storage.sqlite'

const migrationsDir = new URL('./migrations/', import.meta.url)
const schema = readdirSync(migrationsDir)
	.filter((f) => f.endsWith('.sql'))
	.sort()
	.map((f) => readFileSync(new URL(f, migrationsDir), 'utf8'))
	.join('\n')

function makeDb(): { db: DbAdapter; storage: ReturnType<typeof sqliteStorage> } {
	const raw = new DatabaseSync(':memory:')
	raw.exec(schema)
	const db64 = {
		prepare(sql: string) {
			const stmt = raw.prepare(sql)
			stmt.setReadBigInts(true)
			return stmt
		},
		exec: (sql: string) => raw.exec(sql)
	}
	const db = createSqliteAdapter(db64 as unknown as Parameters<typeof createSqliteAdapter>[0])
	return { db, storage: sqliteStorage(db) }
}

const enc = new TextEncoder()

describe('reset — pure CAS decision', () => {
	const at = (o: Partial<GenerationState> = {}): GenerationState => ({ generation: 5, ...o })

	it('decideReset CAS: applies only at fromGeneration, bumps + records resetId', () => {
		const ok = decideReset(at(), { mode: 'adopt-mine', fromGeneration: 5, resetId: 'r1' })
		expect(ok).toEqual({ ok: true, next: { generation: 6, resetId: 'r1' } })

		const wipe = decideReset(at(), { mode: 'wipe', fromGeneration: 5 })
		expect(wipe).toEqual({ ok: true, next: { generation: 6, resetId: undefined } })

		const stale = decideReset(at(), { mode: 'wipe', fromGeneration: 4 })
		expect(stale).toEqual({ ok: false, error: 'generation_stale', generation: 5 })
	})
})

describe('reset — transaction body', () => {
	it('CAS bumps the generation and rejects a stale fromGeneration', async () => {
		const { db } = makeDb()
		expect((await readGenerationState(db)).generation).toBe(1)

		const ok = await resetVolume(db, { mode: 'wipe', fromGeneration: 1 })
		expect(ok).toEqual({ ok: true, next: { generation: 2, resetId: undefined } })
		expect((await readGenerationState(db)).generation).toBe(2)

		const stale = await resetVolume(db, { mode: 'wipe', fromGeneration: 1 })
		expect(stale).toEqual({ ok: false, error: 'generation_stale', generation: 2 })
		expect((await readGenerationState(db)).generation).toBe(2) // unchanged
	})

	it('truncates the tree + sync tables and leaves a working root', async () => {
		const { db, storage } = makeDb()
		const vol = volume(storage)
		await vol.writeFile('/a.txt', enc.encode('hello'))
		await vol.mkdir('/dir')
		expect(await vol.exists('/a.txt')).toBe(true)

		await resetVolume(db, { mode: 'wipe', fromGeneration: 1 })

		// The reset writes the DB directly, so an existing volume's dirent/meta cache
		// is stale — a fresh volume (as the DO rebuilds after a reset) sees the truth.
		const fresh = volume(storage)
		// Root survives (regression for the ensureBootstrapped cache bug): a fresh
		// write into the reset volume works, and the old tree is gone.
		expect(await fresh.exists('/a.txt')).toBe(false)
		expect(await fresh.exists('/dir')).toBe(false)
		expect((await fresh.readdir('/')).length).toBe(0)
		await fresh.writeFile('/after.txt', enc.encode('new'))
		expect(new TextDecoder().decode(await fresh.readFile('/after.txt'))).toBe('new')

		// Sync tables were cleared by the reset; only /after.txt's write remains.
		const journal = await db.query('SELECT COUNT(*) AS n FROM fs_path_journal')
		expect(Number((journal[0] as { n: unknown }).n)).toBeGreaterThan(0)
	})

	it('wipe drops content + FTS; the blobs become unfetchable and unsearchable', async () => {
		const { db, storage } = makeDb()
		const vol = volume(storage)
		await vol.writeFile('/note.txt', enc.encode('searchable text'))
		const hash = (await vol.stat('/note.txt')).contentHash
		expect(hash).toBeTruthy()
		expect(await storage.caps?.content?.hasByHash(hash as string)).toBe(true)

		await resetVolume(db, { mode: 'wipe', fromGeneration: 1 })

		expect(await storage.caps?.content?.hasByHash(hash as string)).toBe(false)
		const fts = await db.query('SELECT COUNT(*) AS n FROM fs_content_fts')
		expect(Number((fts[0] as { n: unknown }).n)).toBe(0)
	})

	it('adopt-mine keeps content (lazy blobs) and records the in-progress resetId', async () => {
		const { db, storage } = makeDb()
		const vol = volume(storage)
		await vol.writeFile('/keep.txt', enc.encode('bytes'))
		const hash = (await vol.stat('/keep.txt')).contentHash as string

		const res = await resetVolume(db, { mode: 'adopt-mine', fromGeneration: 1, resetId: 'r1' })
		expect(res.ok).toBe(true)
		expect(await readGenerationState(db)).toEqual({ generation: 2, resetId: 'r1' })
		// Tree gone (fresh volume — the pre-reset cache is stale), but the content
		// blob is retained for the republish.
		expect(await volume(storage).exists('/keep.txt')).toBe(false)
		expect(await storage.caps?.content?.hasByHash(hash)).toBe(true)
	})

	it('rolls back the whole reset if the transaction throws (atomicity path)', async () => {
		const { db, storage } = makeDb()
		const vol = volume(storage)
		await vol.writeFile('/a.txt', enc.encode('hi'))

		// A throwing wrapper mid-transaction must leave the OLD lineage intact.
		const boom: DbAdapter = {
			query: db.query,
			run: db.run,
			transaction: (fn) =>
				db.transaction(async (tx) => {
					await fn(tx)
					throw new Error('crash after body')
				})
		}
		await expect(resetVolume(boom, { mode: 'wipe', fromGeneration: 1 })).rejects.toThrow(
			'crash after body'
		)
		// Old generation + old tree survive (rolled back).
		expect((await readGenerationState(db)).generation).toBe(1)
		expect(await vol.exists('/a.txt')).toBe(true)
	})
})

describe('reset — clearReset (advisory in-progress flag)', () => {
	it('clears the flag only for the matching reset; a stale/duplicate clear is a no-op', async () => {
		const { db } = makeDb()
		await resetVolume(db, { mode: 'adopt-mine', fromGeneration: 1, resetId: 'r1' })
		expect((await readGenerationState(db)).resetId).toBe('r1')

		// A non-matching resetId leaves the flag untouched.
		const other = await clearReset(db, 'someone-else')
		expect(other).toEqual({ generation: 2, resetId: 'r1' })
		expect((await readGenerationState(db)).resetId).toBe('r1')

		// The owner clears it; the generation is unchanged.
		const owner = await clearReset(db, 'r1')
		expect(owner).toEqual({ generation: 2 })
		expect((await readGenerationState(db)).resetId).toBeUndefined()

		// Idempotent — a retried clear after it's already cleared is a harmless no-op.
		expect(await clearReset(db, 'r1')).toEqual({ generation: 2 })
	})
})
