/**
 * Server-coordinated volume reset.
 *
 * Split so the decision logic is a pure, testable module and the IO is a thin
 * transactional body:
 *
 * - `decideReset` — a pure CAS over the `fs_generation` row: `fromGeneration` must
 *   match, so racing resets can't double-bump; `operationId` makes delivery
 *   idempotent and `resetId` names an adopt-mine republish.
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

const RESET_PRESERVE_PREFIXES = ['/.state', '/private'] as const

// Root inode + storage-kind constants, matching storage.sqlite.ts's bootstrap
// INSERT so a reset recreates an identical root (kept local to keep this module
// dependency-free of the storage internals).
const ROOT_INO = '1'
const TYPE_DIRECTORY = 1 // FileType.Directory
const STORAGE_NONE = 0

// Tables a reset always clears. Tree = the inode graph; sync = path and node
// identity/journal state. Content is mode-specific (see `resetVolume`). Child rows
// first: fs_dirents/fs_xattrs FK-reference fs_inodes (ON DELETE RESTRICT), so the
// inodes can only be deleted once nothing points at them.
const TREE_TABLES = ['fs_dirents', 'fs_xattrs', 'fs_inodes'] as const
const SYNC_TABLES = [
	'fs_path_journal',
	'fs_path_version',
	'fs_node_operations',
	'fs_node_journal_mutations',
	'fs_node_journal',
	'fs_sync_nodes'
] as const
const CONTENT_TABLES = ['fs_contents', 'fs_content_fts'] as const

export type ResetMode = 'adopt-mine' | 'wipe'

/**
 * Every inode of the private roots (`/private`, `/.state`) plus the root itself,
 * resolved through dirents.
 *
 * An `adopt-mine` truncates the tree so the initiator can republish it — but the
 * initiator CANNOT republish these: they never cross the wire, by design, so
 * truncating them would destroy THIS host's own credentials with no way back (the
 * client's snapshot has never contained them). A `wipe` is an explicit "delete
 * everything", so it keeps deleting them.
 *
 * A plain BFS, not a recursive CTE: the tree is a handful of small JSON files, and
 * this stays portable across the DO and node:sqlite with no JSON1/CTE assumptions.
 */
async function privateInos(tx: DbAdapter): Promise<string[]> {
	const keep = new Set<string>()
	const queue: string[] = []
	for (const prefix of RESET_PRESERVE_PREFIXES) {
		let ino: string | undefined = ROOT_INO
		for (const segment of prefix.split('/').filter(Boolean)) {
			const rows: { ino: unknown }[] = await tx.query<{ ino: unknown }>(
				'SELECT ino FROM fs_dirents WHERE dir_ino = ? AND name = ? LIMIT 1',
				[ino, segment]
			)
			ino = rows[0] === undefined ? undefined : String(rows[0].ino)
			if (ino === undefined) break
		}
		if (ino !== undefined) queue.push(ino)
	}
	if (queue.length === 0) return []
	// The root is kept too: a preserved subtree's dirent FK-references it (ON DELETE
	// RESTRICT), so deleting the root would fail — and the volume needs one anyway.
	keep.add(ROOT_INO)
	while (queue.length > 0) {
		const ino = queue.pop() as string
		if (keep.has(ino)) continue
		keep.add(ino)
		for (const row of await tx.query<{ ino: unknown }>(
			'SELECT ino FROM fs_dirents WHERE dir_ino = ?',
			[ino]
		))
			queue.push(String(row.ino))
	}
	return [...keep]
}

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
	// The latest destructive reset committed in the same transaction as its
	// generation bump. Unlike resetId, this survives adopt completion and also
	// exists for wipe, so the outer Worker can prove an ambiguous disconnect.
	committedReset?: { operationId: string; generation: number }
}

export type ResetRequest = {
	mode: ResetMode
	fromGeneration: number
	operationId: string
	resetId?: string
	// The volume identity the initiator believes it is resetting. When present, it must
	// match the volume's own `lineageId` or the reset is rejected — the /reset route is
	// fence-exempt (a stale client must be able to reset), so this is the ONLY guard that
	// stops an adopt-mine from truncating a DIFFERENT volume at the same generation.
	lineageId?: string
}

export type ResetDecision =
	| { ok: true; next: GenerationState; replayed?: true }
	| { ok: false; error: 'generation_stale' | 'lineage_stale'; generation: number }

// The answer to "did MY reset land?", asked of a fresh instance after the committing one
// terminated itself. `committed` is what the caller waits for; `generation` lets a negative
// answer still report where the volume actually is.
export type ResetStatus =
	| { committed: true; generation: number }
	| { committed: false; generation: number }

// ── Pure decision ───────────────────────────────────────────────────────────

/**
 * CAS on `fromGeneration`: apply only if it equals the current generation, so two
 * racing resets can't interleave or double-bump. On success the next state bumps
 * the generation and records `resetId` (the in-progress flag; a `wipe` initiator
 * re-bootstraps rather than republishing, so it may omit it).
 */
export function decideReset(current: GenerationState, req: ResetRequest): ResetDecision {
	if (current.committedReset?.operationId === req.operationId)
		return { ok: true, next: current, replayed: true }
	if (req.fromGeneration !== current.generation)
		return { ok: false, error: 'generation_stale', generation: current.generation }
	// Identity CAS, atomic with the generation CAS: when THIS volume has an identity, an
	// `adopt-mine` MUST name the matching one — a MISSING or mismatched lineageId is
	// rejected, so a redirected (or pre-lineage) client can't truncate a different volume
	// at the same generation (the /reset route bypasses the push fence). Other modes are
	// checked only when they DO carry a lineageId.
	if (
		current.lineageId !== undefined &&
		(req.mode === 'adopt-mine' || req.lineageId !== undefined) &&
		req.lineageId !== current.lineageId
	)
		return { ok: false, error: 'lineage_stale', generation: current.generation }
	// A reset is the SAME volume at a new epoch, so `lineageId` is carried through
	// unchanged — only the `generation` bumps.
	return {
		ok: true,
		next: {
			generation: current.generation + 1,
			resetId: req.resetId,
			lineageId: current.lineageId,
			committedReset: {
				operationId: req.operationId,
				generation: current.generation + 1
			}
		}
	}
}

// ── Row IO ────────────────────────────────────────────────────────────────────

/** Read the decoded generation row (pre-migration default: generation 1). */
export async function readGenerationState(db: DbAdapter): Promise<GenerationState> {
	const [row] = await db.query<{
		generation: unknown
		reset_id: unknown
		lineage_id: unknown
		reset_operation_id: unknown
		reset_operation_generation: unknown
	}>(
		`SELECT generation, reset_id, lineage_id, reset_operation_id, reset_operation_generation
		 FROM fs_generation WHERE id = 1 LIMIT 1`
	)
	if (!row) return { generation: 1 }
	return {
		generation: Number(row.generation),
		resetId: row.reset_id == null ? undefined : String(row.reset_id),
		lineageId: row.lineage_id == null ? undefined : String(row.lineage_id),
		committedReset:
			row.reset_operation_id == null || row.reset_operation_generation == null
				? undefined
				: {
						operationId: String(row.reset_operation_id),
						generation: Number(row.reset_operation_generation)
					}
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
		`INSERT INTO fs_generation(
			id, generation, reset_id, reset_operation_id, reset_operation_generation
		 ) VALUES (1, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
			generation = excluded.generation,
			reset_id = excluded.reset_id,
			reset_operation_id = excluded.reset_operation_id,
			reset_operation_generation = excluded.reset_operation_generation`,
		[
			next.generation,
			next.resetId ?? null,
			next.committedReset?.operationId ?? null,
			next.committedReset?.generation ?? null
		]
	)
}

/**
 * Whether `operationId` is the reset this volume last committed. The committing instance
 * terminates itself the moment the commit is durable, so its caller never receives an
 * answer — this is how that caller proves, against a fresh instance, that the disconnect it
 * saw was a success rather than a failure.
 */
export async function readResetStatus(db: DbAdapter, operationId: string): Promise<ResetStatus> {
	const state = await readGenerationState(db)
	return state.committedReset?.operationId === operationId
		? { committed: true, generation: state.committedReset.generation }
		: { committed: false, generation: state.generation }
}

// ── Transaction bodies ──────────────────────────────────────────────────────────

/**
 * Apply a reset in ONE transaction: CAS, truncate the tree + sync tables (+ the
 * content tables for `wipe`, so no client can fetch/search discarded bytes),
 * recreate the root inode, bump the generation, and store the operation acknowledgement
 * plus `resetId`. `adopt-mine`
 * keeps the content tables — lazy blobs the republish reuses — and the private
 * subtrees, which no republish could restore (see `privateInos`).
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
		if (decision.replayed) {
			result = decision
			return
		}
		const keep = req.mode === 'adopt-mine' ? await privateInos(tx) : []
		const survives = keep.length > 0 ? ` WHERE ino NOT IN (${keep.map(() => '?').join(',')})` : ''
		// Child rows first (FK RESTRICT), and the kept closure is complete — every
		// surviving dirent's `dir_ino` is in `keep` too, so no FK is left dangling.
		for (const table of TREE_TABLES) await tx.run(`DELETE FROM ${table}${survives}`, keep)
		for (const table of SYNC_TABLES) await tx.run(`DELETE FROM ${table}`)
		await tx.run('UPDATE fs_node_clock SET head = 0 WHERE id = 1')
		if (req.mode === 'wipe')
			for (const table of CONTENT_TABLES) await tx.run(`DELETE FROM ${table}`)
		// Recreate root ino=1 so the volume has a root immediately (the storage's
		// ensureBootstrapped cache would otherwise skip re-seeding it). DO NOTHING, not
		// REPLACE: a preserved root must keep its identity (REPLACE is delete+insert,
		// which a kept dirent's FK would refuse). Identical when the tree was truncated.
		const now = BigInt(Date.now()) * 1_000_000n
		await tx.run(
			`INSERT INTO fs_inodes(
				ino, type, mode, size, mtime_ns, ctime_ns, content_hash, symlink_target, mime_type, storage_kind
			) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)
			 ON CONFLICT(ino) DO NOTHING`,
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
			const next = { ...current, resetId: undefined }
			await writeGenerationState(tx, next)
			result = next
		} else {
			result = current
		}
	})
	if (!result) throw new Error('clearReset: transaction did not resolve')
	return result
}
