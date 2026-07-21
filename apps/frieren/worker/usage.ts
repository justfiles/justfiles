import type { Usage } from '@earendil-works/pi-ai'
import type { DbAdapter } from '@justfiles/core'

// Per-user AI usage + quota, in the DO's own SQLite (one DO == one account). The store is
// correct on its own: `reserve` and `settle` are each a SINGLE atomic SQL statement, and a
// DO is single-threaded, so overlapping inference requests can't race a read-modify-write —
// no locks, no serialization in the DO. Only platform-key spend (our OpenRouter key) is
// metered here; BYO backends never call these (see Frieren.meteredBackend).
//
//   reserve(limit) → admit iff committed + reserved + est ≤ limit, atomically bumping
//                    `reserved` in the same statement (bounds concurrent overshoot to the
//                    in-flight calls' reservations, not "everyone reads the same low value").
//   settle(usage)  → free the reservation and add the ACTUAL cost to `committed`.
//   release()      → free the reservation when a call failed before producing usage.
//
// Cost is stored as integer micro-USD (USD × 1e6) to avoid float drift over a month.

export const MICROS_PER_USD = 1_000_000

// Nominal per-call reservation held between reserve and settle. Reconciled to the real cost
// on settle, so it only affects the narrow window near the cap: with headroom H, at most
// ~H/RESERVE calls admit concurrently, bounding overshoot. Tunable; not a correctness knob.
const RESERVE_MICROS = 20_000 // $0.02

// The R2 storage_kind in fs_contents (see storage.sqlite.ts STORAGE_R2). Anything else in
// that table is inline SQLite content.
const STORAGE_R2 = 2

// AI counter, windowed to the current UTC month (rolled atomically inside reserve/settle)
// plus a never-reset lifetime total. `costUsd` is pi's estimate from model pricing, NOT the
// OpenRouter invoice. `requests` counts provider calls (a prompt drives several turns).
export interface AiUsage {
	window: string // 'YYYY-MM' (UTC)
	costUsd: number
	totalTokens: number
	requests: number
	lifetimeCostUsd: number
	lifetimeRequests: number
}

// Point-in-time storage footprint. `logicalBytes` is the user's DEDUPED content (one row per
// unique blob in the content-addressed `fs_contents`) and is the billable metric.
// `physicalBytes` (DO SQLite `databaseSize`) also covers the FTS index + sync journal +
// xattrs and EXCLUDES R2, so it's a DO-footprint signal, not the storage bill.
export interface StorageUsage {
	logicalBytes: number
	blobCount: number
	inlineBytes: number
	r2Bytes: number
	physicalBytes: number
}

export interface UsageReport {
	ai: AiUsage
	storage: StorageUsage
}

function currentWindow(now = Date.now()): string {
	return new Date(now).toISOString().slice(0, 7)
}

// Create the one-row counter table and clear stale reservations. Called once per DO boot
// (in reset), before any request — a fresh instance has no in-flight calls, so zeroing
// `reserved` reclaims reservations leaked by a prior instance that died mid-call.
export async function ensureUsageSchema(db: DbAdapter): Promise<void> {
	await db.run(
		`CREATE TABLE IF NOT EXISTS usage_ai (
			id INTEGER PRIMARY KEY,
			window TEXT NOT NULL,
			committed_micros INTEGER NOT NULL DEFAULT 0,
			reserved_micros INTEGER NOT NULL DEFAULT 0,
			tokens INTEGER NOT NULL DEFAULT 0,
			requests INTEGER NOT NULL DEFAULT 0,
			lifetime_micros INTEGER NOT NULL DEFAULT 0,
			lifetime_requests INTEGER NOT NULL DEFAULT 0
		)`
	)
	await db.run('INSERT OR IGNORE INTO usage_ai (id, window) VALUES (1, ?)', [currentWindow()])
	await db.run('UPDATE usage_ai SET reserved_micros = 0 WHERE id = 1')
}

// Atomically admit a call and hold a reservation, rolling the month in the same statement.
// One statement ⇒ atomic on the single-threaded DO; concurrent reserves each see the prior
// one's reservation. Returns false (0 rows updated) when the budget is spent.
export async function reserve(db: DbAdapter, limitMicros: number): Promise<boolean> {
	const cur = currentWindow()
	const rows = await db.query(
		`UPDATE usage_ai SET
			committed_micros = CASE WHEN window = ? THEN committed_micros ELSE 0 END,
			tokens = CASE WHEN window = ? THEN tokens ELSE 0 END,
			requests = CASE WHEN window = ? THEN requests ELSE 0 END,
			reserved_micros = (CASE WHEN window = ? THEN reserved_micros ELSE 0 END) + ?,
			window = ?
		 WHERE id = 1
		   AND (CASE WHEN window = ? THEN committed_micros + reserved_micros ELSE 0 END) + ? <= ?
		 RETURNING 1`,
		[cur, cur, cur, cur, RESERVE_MICROS, cur, cur, RESERVE_MICROS, limitMicros]
	)
	return rows.length > 0
}

// Free the reservation and record the ACTUAL cost (rolls the month too, so it stays correct
// for unlimited-tier calls that skip reserve). One atomic statement.
export async function settle(db: DbAdapter, usage: Usage): Promise<void> {
	const cur = currentWindow()
	const actual = Math.round(usage.cost.total * MICROS_PER_USD)
	await db.run(
		`UPDATE usage_ai SET
			committed_micros = (CASE WHEN window = ? THEN committed_micros ELSE 0 END) + ?,
			reserved_micros = MAX(0, (CASE WHEN window = ? THEN reserved_micros ELSE 0 END) - ?),
			tokens = (CASE WHEN window = ? THEN tokens ELSE 0 END) + ?,
			requests = (CASE WHEN window = ? THEN requests ELSE 0 END) + 1,
			lifetime_micros = lifetime_micros + ?,
			lifetime_requests = lifetime_requests + 1,
			window = ?
		 WHERE id = 1`,
		[cur, actual, cur, RESERVE_MICROS, cur, usage.totalTokens, cur, actual, cur]
	)
}

// Free a reservation for a call that failed before producing any usage (nothing to count).
export async function release(db: DbAdapter): Promise<void> {
	await db.run('UPDATE usage_ai SET reserved_micros = MAX(0, reserved_micros - ?) WHERE id = 1', [
		RESERVE_MICROS
	])
}

// Read the AI counter as of the current window (a stale month reads as zeroed windowed
// counters, lifetime carried). Pure read — the roll is persisted lazily by reserve/settle.
export async function readAiUsage(db: DbAdapter): Promise<AiUsage> {
	const cur = currentWindow()
	const [row] = await db.query<{
		window: unknown
		committed_micros: unknown
		tokens: unknown
		requests: unknown
		lifetime_micros: unknown
		lifetime_requests: unknown
	}>('SELECT * FROM usage_ai WHERE id = 1')
	if (!row) {
		return {
			window: cur,
			costUsd: 0,
			totalTokens: 0,
			requests: 0,
			lifetimeCostUsd: 0,
			lifetimeRequests: 0
		}
	}
	const fresh = String(row.window) === cur
	return {
		window: cur,
		costUsd: fresh ? Number(row.committed_micros) / MICROS_PER_USD : 0,
		totalTokens: fresh ? Number(row.tokens) : 0,
		requests: fresh ? Number(row.requests) : 0,
		lifetimeCostUsd: Number(row.lifetime_micros) / MICROS_PER_USD,
		lifetimeRequests: Number(row.lifetime_requests)
	}
}

// Read the current usage report. `physicalBytes` is supplied by the DO (ctx.storage.sql
// .databaseSize) since this module has no Cloudflare knowledge.
export async function readUsage(db: DbAdapter, physicalBytes: number): Promise<UsageReport> {
	const ai = await readAiUsage(db)
	// Count only content still REFERENCED by an inode (deduped: one row per unique blob).
	// The sync push uploads blobs before applying path changes, and blob GC is out-of-band
	// (not run in production), so fs_contents can hold orphaned rows; counting them would
	// report storage the user can't reduce by deleting files.
	const rows = await db.query<{ storage_kind: unknown; bytes: unknown; n: unknown }>(
		`SELECT c.storage_kind, COALESCE(SUM(c.size), 0) AS bytes, COUNT(*) AS n
		 FROM fs_contents c
		 WHERE EXISTS (SELECT 1 FROM fs_inodes i WHERE i.content_hash = c.content_hash)
		 GROUP BY c.storage_kind`
	)
	const storageUsage: StorageUsage = {
		logicalBytes: 0,
		blobCount: 0,
		inlineBytes: 0,
		r2Bytes: 0,
		physicalBytes
	}
	for (const row of rows) {
		const bytes = Number(row.bytes)
		storageUsage.logicalBytes += bytes
		storageUsage.blobCount += Number(row.n)
		if (Number(row.storage_kind) === STORAGE_R2) storageUsage.r2Bytes += bytes
		else storageUsage.inlineBytes += bytes
	}
	return { ai, storage: storageUsage }
}
