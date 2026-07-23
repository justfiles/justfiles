/**
 * Server-coordinated volume reset.
 *
 * Split so the decision logic is a pure, testable module and the IO is a thin
 * transactional body:
 *
 * - `decideReset` — a pure CAS over the `fs_generation` row: `fromGeneration` must
 *   match, so racing resets can't double-bump; `resetId` names the winner.
 * - `resetVolume` — one SQLite transaction that CAS-checks, truncates the tree +
 *   sync tables (+ content for `wipe`), recreates the root inode, and bumps
 *   `generation`. Atomic against a real BEGIN/COMMIT adapter.
 *
 * The republish after a "take mine" is ordinary sync, not a special server op, so
 * there is no publishing lock or finalize. `resetId` is an advisory "reset in
 * progress" flag, cleared by `clearReset` when the republish drains; a
 * stale/never-sent clear is a harmless no-op. The reset endpoints live outside
 * `createFsApi` (they need DO-level powers); this module is the body they call.
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
	// The reset that produced this generation, while its republish is in progress
	// (cleared by `clearReset` on completion). Advisory: crash-resume identity +
	// UI legibility, NOT a write lock.
	resetId?: string
	// Stable, unique per-volume identity (see 0005_lineage_id.sql). Distinct from
	// `generation` (an epoch counter seeded to 1 everywhere): `lineageId` answers "is
	// this the SAME volume?", so a client that observes a different one re-bootstraps
	// instead of reusing cursors minted against another volume. A reset keeps it (same
	// volume, new epoch); only a genuinely new volume mints a new one.
	lineageId?: string
}

export type ResetRequest = {
	mode: ResetMode
	fromGeneration: number
	resetId?: string
}

export type ResetDecision =
	| { ok: true; next: GenerationState }
	| { ok: false; error: 'generation_stale'; generation: number }

// ── Pure decision ───────────────────────────────────────────────────────────

/**
 * CAS on `fromGeneration`: apply only if it equals the current generation, so two
 * racing resets can't interleave or double-bump. On success the next state bumps
 * the generation and records `resetId` (the in-progress flag; a `wipe` initiator
 * re-bootstraps rather than republishing, so it may omit it).
 */
export function decideReset(current: GenerationState, req: ResetRequest): ResetDecision {
	if (req.fromGeneration !== current.generation)
		return { ok: false, error: 'generation_stale', generation: current.generation }
	// A reset is the SAME volume at a new epoch, so `lineageId` is carried through
	// unchanged — only the `generation` bumps.
	return {
		ok: true,
		next: { generation: current.generation + 1, resetId: req.resetId, lineageId: current.lineageId }
	}
}

// ── Row IO ────────────────────────────────────────────────────────────────────

/** Read the decoded generation row (pre-migration default: generation 1). */
export async function readGenerationState(db: DbAdapter): Promise<GenerationState> {
	const [row] = await db.query<{ generation: unknown; reset_id: unknown; lineage_id: unknown }>(
		'SELECT generation, reset_id, lineage_id FROM fs_generation WHERE id = 1 LIMIT 1'
	)
	if (!row) return { generation: 1 }
	return {
		generation: Number(row.generation),
		resetId: row.reset_id == null ? undefined : String(row.reset_id),
		lineageId: row.lineage_id == null ? undefined : String(row.lineage_id)
	}
}

/** The lineage epoch — the value stamped on the handshake and fenced on writes. */
export async function readGeneration(db: DbAdapter): Promise<number> {
	return (await readGenerationState(db)).generation
}

async function writeGenerationState(db: DbAdapter, next: GenerationState): Promise<void> {
	// `lineage_id` is intentionally NOT in the UPDATE set: it is minted once by the
	// migration and preserved across every reset (same volume, new epoch), so the
	// on-conflict path leaves it untouched.
	await db.run(
		`INSERT INTO fs_generation(id, generation, reset_id) VALUES (1, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
			generation = excluded.generation,
			reset_id = excluded.reset_id`,
		[next.generation, next.resetId ?? null]
	)
}

// ── Transaction bodies ──────────────────────────────────────────────────────────

/**
 * Apply a reset in ONE transaction: CAS, truncate the tree + sync tables (+ the
 * content tables for `wipe`, so no client can fetch/search discarded bytes),
 * recreate the root inode, bump the generation, and store `resetId`. `adopt-mine`
 * keeps the content tables — lazy blobs the republish reuses.
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
 * Clear the advisory "reset in progress" flag once the republish drained, iff
 * `resetId` still names the current reset. No CAS rigor: a stale/duplicate clear
 * is a harmless no-op, a never-sent one just leaves the flag lingering (cosmetic).
 * Returns the resulting state so the caller can echo the current generation.
 */
export async function clearReset(db: DbAdapter, resetId: string): Promise<GenerationState> {
	let result: GenerationState | undefined
	await db.transaction(async (tx) => {
		const current = await readGenerationState(tx)
		if (current.resetId === resetId) {
			const next = { generation: current.generation }
			await writeGenerationState(tx, next)
			result = next
		} else {
			result = current
		}
	})
	if (!result) throw new Error('clearReset: transaction did not resolve')
	return result
}
