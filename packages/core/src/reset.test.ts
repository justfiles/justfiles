// Volume reset: the pure CAS decision, the lineage identity it carries through, and
// the advisory in-progress flag — driven against a REAL BEGIN/COMMIT adapter over
// node:sqlite, so the transactional paths run under vitest with no bun / Cloudflare
// runtime.
//
// What a reset APPLIES lives in `reset.store.test.ts`: the tree it empties is a store,
// and the whole body is one `transactionSync`. This file is everything around that.

import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { ROOT } from '@justfiles/fs/store'
import { describe, expect, it } from 'vitest'
import type { DbAdapter, SyncDb } from './db'
import { createSqliteAdapter, createSqliteSyncDb } from './db.sqlite'
import {
	clearReset,
	decideReset,
	type GenerationState,
	readGenerationState,
	readResetStatus,
	resetStore
} from './reset'
import { sqliteStore } from './store.sqlite'

const migrationsDir = new URL('./migrations/', import.meta.url)
const schema = readdirSync(migrationsDir)
	.filter((f) => f.endsWith('.sql'))
	.sort()
	.map((f) => readFileSync(new URL(f, migrationsDir), 'utf8'))
	.join('\n')

/** One database, both seams: the reset is atomic and synchronous, the reads are not. */
async function makeDb(): Promise<{ db: DbAdapter; sync: SyncDb }> {
	const raw = new DatabaseSync(':memory:')
	raw.exec(schema)
	const db64 = {
		prepare(sql: string) {
			const stmt = raw.prepare(sql)
			stmt.setReadBigInts(true)
			return stmt
		},
		exec: (sql: string) => raw.exec(sql)
	} as unknown as Parameters<typeof createSqliteAdapter>[0]
	const sync = createSqliteSyncDb(db64)
	// The store's own tables are created when a store is first opened, and a reset
	// empties them — so a host always has one before it can reset anything.
	await sqliteStore(sync).get(ROOT)
	return { db: createSqliteAdapter(db64), sync }
}

describe('reset — pure CAS decision', () => {
	const at = (o: Partial<GenerationState> = {}): GenerationState => ({ generation: 5, ...o })

	it('decideReset CAS: applies only at fromGeneration, bumps + records resetId', () => {
		const ok = decideReset(at(), {
			mode: 'adopt-mine',
			fromGeneration: 5,
			operationId: 'op-1',
			resetId: 'r1'
		})
		expect(ok).toEqual({
			ok: true,
			next: {
				generation: 6,
				resetId: 'r1',
				committedReset: { operationId: 'op-1', generation: 6 }
			}
		})

		const wipe = decideReset(at(), { mode: 'wipe', fromGeneration: 5, operationId: 'op-2' })
		expect(wipe).toMatchObject({ ok: true, next: { generation: 6 } })

		const stale = decideReset(at(), { mode: 'wipe', fromGeneration: 4, operationId: 'op-3' })
		expect(stale).toEqual({ ok: false, error: 'generation_stale', generation: 5 })
	})
})

describe('reset — lineage identity (issue #245)', () => {
	// A stable, unique per-volume id disambiguates two volumes that both read
	// `generation: 1` — the root-cause fix for cursors reused across volumes.
	it('mints a stable, unique lineageId per fresh volume', async () => {
		const { db: a } = await makeDb()
		const { db: b } = await makeDb()
		const aId = (await readGenerationState(a)).lineageId
		const bId = (await readGenerationState(b)).lineageId
		expect(aId).toMatch(/^[0-9a-f]{32}$/) // defined — 16 random bytes as hex
		expect(bId).toMatch(/^[0-9a-f]{32}$/)
		expect(aId).not.toBe(bId) // unique across independent volumes
		expect((await readGenerationState(a)).lineageId).toBe(aId) // stable across reads
	})

	// A reset is the SAME volume at a new epoch: bump `generation`, keep `lineageId`.
	it('a reset bumps the generation but keeps the lineageId', async () => {
		const { db, sync } = await makeDb()
		const before = await readGenerationState(db)
		expect(before.lineageId).toBeDefined()

		// Pure decision carries the lineageId through unchanged.
		expect(
			decideReset(before, {
				mode: 'wipe',
				fromGeneration: before.generation,
				operationId: 'op-1'
			})
		).toMatchObject({
			ok: true,
			next: {
				generation: before.generation + 1,
				lineageId: before.lineageId
			}
		})

		// Transaction body: generation bumps, lineageId is untouched.
		resetStore(sync, {
			mode: 'adopt-mine',
			fromGeneration: before.generation,
			operationId: 'op-2',
			resetId: 'r1',
			lineageId: before.lineageId
		})
		const after = await readGenerationState(db)
		expect(after.generation).toBe(before.generation + 1)
		expect(after.lineageId).toBe(before.lineageId)
	})

	// Identity CAS: an adopt-mine that names a DIFFERENT volume's lineage must be rejected
	// (the /reset route is fence-exempt, so this is the only guard) and must not truncate.
	it('decideReset rejects an adopt-mine whose lineageId does not match', () => {
		const current: GenerationState = { generation: 5, lineageId: 'vol-A' }
		expect(
			decideReset(current, {
				mode: 'adopt-mine',
				fromGeneration: 5,
				operationId: 'op-1',
				resetId: 'r1',
				lineageId: 'vol-B'
			})
		).toEqual({ ok: false, error: 'lineage_stale', generation: 5 })
		expect(
			decideReset(current, {
				mode: 'adopt-mine',
				fromGeneration: 5,
				operationId: 'op-2',
				resetId: 'r1',
				lineageId: 'vol-A'
			})
		).toMatchObject({ ok: true, next: { generation: 6, resetId: 'r1', lineageId: 'vol-A' } })
	})

	// A MISSING lineageId is rejected too (not just a mismatched one): a pre-lineage or
	// redirected client that can't prove identity must not truncate a volume that has one.
	// `wipe` (factory reset) is NOT forced to carry a lineageId.
	it('decideReset requires a lineageId for adopt-mine, but not for wipe', () => {
		const current: GenerationState = { generation: 5, lineageId: 'vol-A' }
		expect(
			decideReset(current, {
				mode: 'adopt-mine',
				fromGeneration: 5,
				operationId: 'op-1',
				resetId: 'r1'
			})
		).toEqual({ ok: false, error: 'lineage_stale', generation: 5 })
		expect(
			decideReset(current, { mode: 'wipe', fromGeneration: 5, operationId: 'op-2' })
		).toMatchObject({ ok: true, next: { generation: 6, lineageId: 'vol-A' } })
	})
})

describe('reset — clearReset (advisory in-progress flag)', () => {
	it('clears the flag only for the matching reset; a stale/duplicate clear is a no-op', async () => {
		const { db, sync } = await makeDb()
		const { lineageId } = await readGenerationState(db)
		resetStore(sync, {
			mode: 'adopt-mine',
			fromGeneration: 1,
			operationId: 'op-1',
			resetId: 'r1',
			lineageId
		})
		expect((await readGenerationState(db)).resetId).toBe('r1')

		// A non-matching resetId leaves the flag untouched.
		const other = await clearReset(db, 'someone-else')
		expect(other).toMatchObject({ generation: 2, resetId: 'r1' })
		expect((await readGenerationState(db)).resetId).toBe('r1')

		// The owner clears it; the generation is unchanged.
		const owner = await clearReset(db, 'r1')
		expect(owner).toMatchObject({ generation: 2, resetId: undefined })
		expect((await readGenerationState(db)).resetId).toBeUndefined()
		expect(await readResetStatus(db, 'op-1')).toEqual({ committed: true, generation: 2 })

		// Idempotent — a retried clear after it's already cleared is a harmless no-op.
		expect(await clearReset(db, 'r1')).toMatchObject({ generation: 2 })
	})
})
