/**
 * Server-coordinated volume reset.
 *
 * Split so the decision logic is a pure, testable module and the IO is a thin
 * transactional body:
 *
 * - `decideReset` — a pure CAS over the `fs_generation` row: `fromGeneration` must
 *   match, so racing resets can't double-bump; `operationId` makes delivery
 *   idempotent and `resetId` names an adopt-mine republish.
 * - `resetStore` — one ATOMIC transaction that CAS-checks, empties the stores the
 *   mode names, and bumps `generation`.
 *
 * The republish after a "take mine" is ordinary sync, not a special server op, so
 * there is no publishing lock or finalize. `resetId` is an advisory "reset in
 * progress" flag, cleared by `clearReset` when the republish drains; a
 * stale/never-sent clear is a harmless no-op. The DESTRUCTIVE endpoints live outside
 * `createFsApi` (they need DO-level powers); this module is the body they call.
 */

import type { DbAdapter, SyncDb } from './db'
import { emptyStore } from './store.sqlite'

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

/**
 * The generation row, as SQL and a codec — written once and read through both
 * seams. The row is the same row whichever one asks for it: `DbAdapter` for the
 * routes that only READ it, `SyncDb` for the reset that has to be atomic (`db.ts`).
 */
const GENERATION_SELECT = `SELECT generation, reset_id, lineage_id,
		reset_operation_id, reset_operation_generation
	FROM fs_generation WHERE id = 1 LIMIT 1`

// `lineage_id` is intentionally NOT in the UPDATE set: it is minted once by the
// migration and preserved across every reset (same volume, new epoch), so the
// on-conflict path leaves it untouched.
const GENERATION_UPSERT = `INSERT INTO fs_generation(
		id, generation, reset_id, reset_operation_id, reset_operation_generation
	) VALUES (1, ?, ?, ?, ?)
	ON CONFLICT(id) DO UPDATE SET
		generation = excluded.generation,
		reset_id = excluded.reset_id,
		reset_operation_id = excluded.reset_operation_id,
		reset_operation_generation = excluded.reset_operation_generation`

/** Pre-migration default: generation 1. */
const decodeGeneration = (row: Record<string, unknown> | undefined): GenerationState => {
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

const generationArgs = (next: GenerationState) => [
	next.generation,
	next.resetId ?? null,
	next.committedReset?.operationId ?? null,
	next.committedReset?.generation ?? null
]

/** Read the decoded generation row (pre-migration default: generation 1). */
export async function readGenerationState(db: DbAdapter): Promise<GenerationState> {
	return decodeGeneration((await db.query(GENERATION_SELECT))[0])
}

async function writeGenerationState(db: DbAdapter, next: GenerationState): Promise<void> {
	await db.run(GENERATION_UPSERT, generationArgs(next))
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
 * What a reset empties: the synced tree, and — for a wipe — the host's own stores
 * joined at a name.
 *
 * The old model had to walk out the subtrees an adopt-mine must not destroy, because
 * they were rows in the same tree it was truncating. Here they are a DIFFERENT STORE, so
 * keeping them is not something this has to remember to do: an adopt-mine names the
 * synced store and the credentials are simply not in it.
 */
export type ResetStores = {
	/** The synced tree, emptied by every mode. Its content survives an `adopt-mine`. */
	synced?: string
	/** Stores bound at a name. A `wipe` means "delete everything", so it empties these too. */
	local?: string[]
}

/**
 * Apply a reset in ONE ATOMIC transaction: the CAS, the empty, and the generation
 * bump together.
 *
 * On the synchronous seam, and that is the point of it. `DbAdapter.transaction` is
 * `await fn(adapter)` on a Durable Object, so a body that fails halfway leaves the
 * statements before it written — and half a reset is a truncated tree at the old
 * generation, which every replica then fails to notice. `transactionSync` is the only
 * transaction there that rolls back, and it takes a synchronous body, which is exactly
 * what `emptyStore` and this CAS are.
 *
 * The caller still has to flush and terminate (`commitReset`): a DO's writes ride the
 * event's implicit transaction and are discarded with the event that is about to abort.
 */
export function resetStore(db: SyncDb, req: ResetRequest, stores: ResetStores = {}): ResetDecision {
	let result: ResetDecision | undefined
	db.transactionSync(() => {
		const current = decodeGeneration(db.query(GENERATION_SELECT)[0])
		const decision = decideReset(current, req)
		result = decision
		if (!decision.ok || decision.replayed) return
		// An adopt-mine keeps the bytes: the initiator republishes rows it may only
		// hold as stubs, and those stubs need something behind them here.
		emptyStore(db, stores.synced, { content: req.mode === 'wipe' ? 'drop' : 'keep' })
		if (req.mode === 'wipe')
			for (const id of stores.local ?? []) emptyStore(db, id, { content: 'drop' })
		db.exec(GENERATION_UPSERT, generationArgs(decision.next))
	})
	if (!result) throw new Error('resetStore: transaction did not resolve')
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
