/**
 * Server-coordinated volume reset (docs/sync-reset-generation.md, step 3).
 *
 * Two halves, deliberately split so the decision logic is a PURE, testable module
 * and the IO is a thin transactional body:
 *
 * - **State machine** (`decideReset` / `decideFinalize` / `decideResume`) — pure
 *   functions over the `fs_generation` row. `fromGeneration` is a compare-and-swap
 *   so racing resets can't double-bump; `resetId` is the winner's id; `publishing`
 *   is the adopt-mine lock.
 * - **Transaction body** (`resetVolume` / `finalizeReset`) — one SQLite transaction
 *   that CAS-checks, truncates the tree + sync tables (+ content for `wipe`),
 *   recreates the root inode, bumps `generation`, and stores `resetId`. Runs on any
 *   `DbAdapter`; against a real BEGIN/COMMIT adapter it is genuinely atomic.
 *
 * The reset endpoints live OUTSIDE `createFsApi` (they need DO-level powers); this
 * module is the shared body they call. `gcUnreferenced` (dropping the discarded
 * baseline's now-orphaned blobs on adopt-mine finalize) is the storage's existing
 * content cap, invoked by the caller before `finalizeReset` clears the lock.
 */

import type { DbAdapter } from './db'

// Root inode + storage-kind constants, matching storage.sqlite.ts's bootstrap
// INSERT so a reset recreates an identical root (kept local to keep this module
// dependency-free of the storage internals).
const ROOT_INO = '1'
const TYPE_DIRECTORY = 1 // FileType.Directory
const STORAGE_NONE = 0

// Tables a reset always clears. Tree = the inode graph; sync = the path journal +
// version generator (its tombstone_version would otherwise fail a republished
// put's LWW check). Content is mode-specific (see `resetVolume`). Child rows
// first: fs_dirents/fs_xattrs FK-reference fs_inodes (ON DELETE RESTRICT), so the
// inodes can only be deleted once nothing points at them.
const TREE_TABLES = ['fs_dirents', 'fs_xattrs', 'fs_inodes'] as const
const SYNC_TABLES = ['fs_path_journal', 'fs_path_version'] as const
const CONTENT_TABLES = ['fs_contents', 'fs_content_fts'] as const

export type ResetMode = 'adopt-mine' | 'wipe'

/** The `fs_generation` row, decoded. */
export interface GenerationState {
	generation: number
	resetId?: string
	publishing: boolean
}

export type ResetRequest = {
	mode: ResetMode
	fromGeneration: number
	resetId?: string
}

export type ResetDecision =
	| { ok: true; next: GenerationState }
	| { ok: false; error: 'generation_stale'; generation: number }

export type FinalizeRequest = { generation: number; resetId: string }

export type FinalizeDecision =
	| { ok: true; next: GenerationState }
	| { ok: false; error: 'generation_stale' | 'not_owner' }

/** Client crash-recovery: what to do with an in-flight adopt-mine on reboot. */
export type ResumeDecision = 'resume' | 'adopt' | 'reset-to-winner'

// ── Pure decisions ────────────────────────────────────────────────────────────

/**
 * CAS on `fromGeneration`: apply only if it equals the current generation, so two
 * racing resets can't interleave or double-bump. On success the next state bumps
 * the generation, records `resetId`, and sets `publishing` for adopt-mine (wipe
 * takes no lock — its initiator discards + re-bootstraps rather than publishing).
 */
export function decideReset(current: GenerationState, req: ResetRequest): ResetDecision {
	if (req.fromGeneration !== current.generation)
		return { ok: false, error: 'generation_stale', generation: current.generation }
	return {
		ok: true,
		next: {
			generation: current.generation + 1,
			resetId: req.resetId,
			publishing: req.mode === 'adopt-mine'
		}
	}
}

/**
 * Finalize (adopt-mine) clears the publishing lock. A CAS on the generation, then
 * owner-only: only the winning `resetId` may clear it (a non-owner is rejected).
 * Idempotent — a retried finalize after the lock is already clear is a no-op ok.
 */
export function decideFinalize(current: GenerationState, req: FinalizeRequest): FinalizeDecision {
	if (current.generation !== req.generation) return { ok: false, error: 'generation_stale' }
	if (current.resetId !== req.resetId) return { ok: false, error: 'not_owner' }
	if (!current.publishing) return { ok: true, next: current } // already finalized
	return { ok: true, next: { ...current, publishing: false } }
}

/**
 * On reboot with a persisted `pendingReset`, decide how to continue: resume the
 * publish only if OUR reset still owns the server AND it is still publishing;
 * adopt if it already finalized (the publish is done); otherwise a different reset
 * won, so client-reset to the winner's baseline.
 */
export function decideResume(
	pending: { resetId: string },
	server: GenerationState
): ResumeDecision {
	if (server.resetId !== pending.resetId) return 'reset-to-winner'
	return server.publishing ? 'resume' : 'adopt'
}

// ── Row IO ────────────────────────────────────────────────────────────────────

/** Read the decoded generation row (pre-migration default: generation 1, unlocked). */
export async function readGenerationState(db: DbAdapter): Promise<GenerationState> {
	const [row] = await db.query<{ generation: unknown; reset_id: unknown; publishing: unknown }>(
		'SELECT generation, reset_id, publishing FROM fs_generation WHERE id = 1 LIMIT 1'
	)
	if (!row) return { generation: 1, publishing: false }
	return {
		generation: Number(row.generation),
		resetId: row.reset_id == null ? undefined : String(row.reset_id),
		publishing: Number(row.publishing) !== 0
	}
}

/** The lineage epoch — the value stamped on the handshake and fenced on writes. */
export async function readGeneration(db: DbAdapter): Promise<number> {
	return (await readGenerationState(db)).generation
}

async function writeGenerationState(db: DbAdapter, next: GenerationState): Promise<void> {
	await db.run(
		`INSERT INTO fs_generation(id, generation, reset_id, publishing) VALUES (1, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
			generation = excluded.generation,
			reset_id = excluded.reset_id,
			publishing = excluded.publishing`,
		[next.generation, next.resetId ?? null, next.publishing ? 1 : 0]
	)
}

// ── Transaction bodies ──────────────────────────────────────────────────────────

/**
 * Apply a reset in ONE transaction: CAS, truncate the tree + sync tables (+ the
 * content tables for `wipe`, so no client can fetch/search discarded bytes),
 * recreate the root inode, bump the generation, and store `resetId`. `adopt-mine`
 * KEEPS the content tables (lazy blobs the republish reuses) and sets the
 * publishing lock; the caller GCs the orphaned baseline at `finalizeReset`.
 */
export async function resetVolume(db: DbAdapter, req: ResetRequest): Promise<ResetDecision> {
	let result: ResetDecision | undefined
	await db.transaction(async (tx) => {
		const current = await readGenerationState(tx)
		const decision = decideReset(current, req)
		if (!decision.ok) {
			result = decision
			return
		}
		const tables: string[] = [...TREE_TABLES, ...SYNC_TABLES]
		if (req.mode === 'wipe') tables.push(...CONTENT_TABLES)
		for (const table of tables) await tx.run(`DELETE FROM ${table}`)
		// Recreate root ino=1 so the volume has a root immediately (the storage's
		// ensureBootstrapped cache would otherwise skip re-seeding it).
		const now = BigInt(Date.now()) * 1_000_000n
		await tx.run(
			`INSERT OR REPLACE INTO fs_inodes(
				ino, type, mode, size, mtime_ns, ctime_ns, content_hash, symlink_target, mime_type, storage_kind
			) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
			[ROOT_INO, TYPE_DIRECTORY, 0o755, 0, now, now, STORAGE_NONE]
		)
		await writeGenerationState(tx, decision.next)
		result = decision
	})
	if (!result) throw new Error('resetVolume: transaction did not resolve')
	return result
}

/**
 * Clear the adopt-mine publishing lock (owner + CAS checked). GC the discarded
 * baseline's orphaned blobs BEFORE calling this (via the storage content cap) so
 * no stale hash can fetch dropped content once pulls reopen.
 */
export async function finalizeReset(
	db: DbAdapter,
	req: FinalizeRequest
): Promise<FinalizeDecision> {
	let result: FinalizeDecision | undefined
	await db.transaction(async (tx) => {
		const current = await readGenerationState(tx)
		const decision = decideFinalize(current, req)
		if (!decision.ok) {
			result = decision
			return
		}
		await writeGenerationState(tx, decision.next)
		result = decision
	})
	if (!result) throw new Error('finalizeReset: transaction did not resolve')
	return result
}

/**
 * Finalize an adopt-mine reset together with its blob GC, in the ONLY safe order:
 * validate owner + CAS FIRST, THEN run `gc`, THEN commit the lock clear. The
 * ownership check must precede the destructive GC — otherwise a stale/non-owner
 * finalize could reclaim the kept lazy blobs and only then be rejected. `gc` is
 * the storage content cap (`gcUnreferenced`) that drops the discarded baseline's
 * now-orphaned blobs; it runs only for the confirmed owner.
 */
export async function finalizeResetWithGc(
	db: DbAdapter,
	req: FinalizeRequest,
	gc: () => Promise<void>
): Promise<FinalizeDecision> {
	const check = decideFinalize(await readGenerationState(db), req)
	if (!check.ok) return check
	await gc()
	return finalizeReset(db, req)
}
