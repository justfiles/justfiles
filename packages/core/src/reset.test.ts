// Volume reset (docs/sync-reset-generation.md, step 3). The pure state machine
// (CAS / ownership / publishing / finalize idempotency / crash-resume) plus the
// transactional reset body, driven against a REAL BEGIN/COMMIT adapter over
// node:sqlite — the same transport the sqlite conformance suite uses, so the
// reset-atomicity code path runs under vitest with no bun / Cloudflare runtime.

import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { volume } from '@justfiles/fs'
import { describe, expect, it } from 'vitest'
import type { DbAdapter } from './db'
import { createSqliteAdapter } from './db.sqlite'
import {
	decideFinalize,
	decideReset,
	decideResume,
	finalizeReset,
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

describe('reset — pure state machine', () => {
	const at = (o: Partial<GenerationState> = {}): GenerationState => ({
		generation: 5,
		publishing: false,
		...o
	})

	it('decideReset CAS: applies only at fromGeneration, bumps + sets publishing for adopt-mine', () => {
		const ok = decideReset(at(), { mode: 'adopt-mine', fromGeneration: 5, resetId: 'r1' })
		expect(ok).toEqual({ ok: true, next: { generation: 6, resetId: 'r1', publishing: true } })

		const wipe = decideReset(at(), { mode: 'wipe', fromGeneration: 5 })
		expect(wipe).toEqual({
			ok: true,
			next: { generation: 6, resetId: undefined, publishing: false }
		})

		const stale = decideReset(at(), { mode: 'wipe', fromGeneration: 4 })
		expect(stale).toEqual({ ok: false, error: 'generation_stale', generation: 5 })
	})

	it('decideFinalize: owner clears the lock; idempotent; non-owner + stale rejected', () => {
		const held = at({ generation: 6, resetId: 'r1', publishing: true })
		expect(decideFinalize(held, { generation: 6, resetId: 'r1' })).toEqual({
			ok: true,
			next: { generation: 6, resetId: 'r1', publishing: false }
		})
		// idempotent no-op after already cleared
		const cleared = at({ generation: 6, resetId: 'r1', publishing: false })
		expect(decideFinalize(cleared, { generation: 6, resetId: 'r1' })).toEqual({
			ok: true,
			next: cleared
		})
		expect(decideFinalize(held, { generation: 6, resetId: 'other' })).toEqual({
			ok: false,
			error: 'not_owner'
		})
		expect(decideFinalize(held, { generation: 7, resetId: 'r1' })).toEqual({
			ok: false,
			error: 'generation_stale'
		})
	})

	it('decideResume: resume while publishing, adopt once finalized, reset to a different winner', () => {
		expect(decideResume({ resetId: 'r1' }, at({ resetId: 'r1', publishing: true }))).toBe('resume')
		expect(decideResume({ resetId: 'r1' }, at({ resetId: 'r1', publishing: false }))).toBe('adopt')
		expect(decideResume({ resetId: 'r1' }, at({ resetId: 'r2', publishing: false }))).toBe(
			'reset-to-winner'
		)
	})
})

describe('reset — transaction body', () => {
	it('CAS bumps the generation and rejects a stale fromGeneration', async () => {
		const { db } = makeDb()
		expect((await readGenerationState(db)).generation).toBe(1)

		const ok = await resetVolume(db, { mode: 'wipe', fromGeneration: 1 })
		expect(ok).toEqual({ ok: true, next: { generation: 2, resetId: undefined, publishing: false } })
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

	it('adopt-mine keeps content (lazy blobs) and sets the publishing lock', async () => {
		const { db, storage } = makeDb()
		const vol = volume(storage)
		await vol.writeFile('/keep.txt', enc.encode('bytes'))
		const hash = (await vol.stat('/keep.txt')).contentHash as string

		const res = await resetVolume(db, { mode: 'adopt-mine', fromGeneration: 1, resetId: 'r1' })
		expect(res.ok).toBe(true)
		const state = await readGenerationState(db)
		expect(state).toEqual({ generation: 2, resetId: 'r1', publishing: true })
		// Tree gone (fresh volume — the pre-reset cache is stale), but the content
		// blob is retained for the republish.
		expect(await volume(storage).exists('/keep.txt')).toBe(false)
		expect(await storage.caps?.content?.hasByHash(hash)).toBe(true)
	})

	it('finalize (adopt-mine): GC drops the orphaned baseline, then the lock clears', async () => {
		const { db, storage } = makeDb()
		const vol = volume(storage)
		await vol.writeFile('/keep.txt', enc.encode('old-baseline'))
		const hash = (await vol.stat('/keep.txt')).contentHash as string

		await resetVolume(db, { mode: 'adopt-mine', fromGeneration: 1, resetId: 'r1' })
		expect((await readGenerationState(db)).publishing).toBe(true)

		// The new tree references nothing yet, so GC reclaims the discarded blob.
		await storage.caps?.content?.gcUnreferenced?.()
		expect(await storage.caps?.content?.hasByHash(hash)).toBe(false)

		const fin = await finalizeReset(db, { generation: 2, resetId: 'r1' })
		expect(fin.ok).toBe(true)
		expect((await readGenerationState(db)).publishing).toBe(false)

		// A retried finalize is a no-op ok; a non-owner is rejected.
		expect((await finalizeReset(db, { generation: 2, resetId: 'r1' })).ok).toBe(true)
		expect(await finalizeReset(db, { generation: 2, resetId: 'other' })).toEqual({
			ok: false,
			error: 'not_owner'
		})
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
