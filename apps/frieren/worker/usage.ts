import type { Usage } from '@earendil-works/pi-ai'
import type { DbAdapter } from '@justfiles/core'

// Per-user AI usage + quota, in the DO's own SQLite (one DO == one account). Two windows
// gate spend, Claude-Code style: a short ROLLING "burst" window (anchored to first use) plus
// a fixed WEEKLY window. A call is admitted only if it fits under BOTH. The store is correct
// on its own: `reserve` and `settle` are each a SINGLE atomic SQL statement, and a DO is
// single-threaded, so overlapping inference requests can't race a read-modify-write — no
// locks. Only platform-key spend (our OpenRouter key) is metered here; BYO backends never
// call these (see Frieren.meteredBackend).
//
//   reserve(now, est, burstLimit, weeklyLimit) → admit iff, for BOTH windows,
//                         committed + reserved + est ≤ limit; atomically bumps each window's
//                         `reserved` by `est` in the same statement and rolls any window that
//                         has elapsed. Returns the HANDLE (each window's key) the reservation
//                         belongs to, or null when either budget is spent.
//   settle(handle, est, usage) → free the reservation (−est) and add ACTUAL cost — per window,
//                         but only if that window still matches the handle (a call that spanned
//                         a window roll can't touch the new window). Lifetime totals always accrue.
//   release(handle, est) → free a reservation for a call that failed before producing usage.
//
// A window's "roll" is detected differently per window, so its key doubles as the ownership
// token settle/release match on:
//   • burst  — ROLLING, anchored: `burst_expires` (ms epoch). Rolls when now ≥ burst_expires;
//              the fresh window is `now + BURST_WINDOW_MS`. Only the expiry is stored, never the
//              length, so BURST_WINDOW_MS can change later with zero migration (live windows keep
//              their set expiry; future ones use the new length).
//   • weekly — FIXED grid: `weekly_key` = weekBucket(now), a pure function of `now`. Rolls when
//              the bucket changes. Boundaries land on Monday 00:00 UTC, shared by all users.
//
// Cost is stored as integer micro-USD (USD × 1e6) to avoid float drift over a window.

export const MICROS_PER_USD = 1_000_000

// The rolling burst window length. Read ONLY when a window rolls (to set the next expiry), so
// changing it is a pure knob — no stored-length, no migration.
export const BURST_WINDOW_MS = 5 * 60 * 60 * 1000 // 5 hours

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
// The Unix epoch (1970-01-01) is a Thursday; shift by 3 days so fixed 7-day buckets break on
// Monday 00:00 UTC. Never change WEEK_MS/this offset: the grid key would misalign at the seam.
const MONDAY_ALIGN_MS = 3 * 24 * 60 * 60 * 1000

// The R2 storage_kind in fs_contents (see storage.sqlite.ts STORAGE_R2). Anything else in
// that table is inline SQLite content.
const STORAGE_R2 = 2

// The fixed weekly bucket for an instant, and the instant the CURRENT bucket resets. Pure
// functions of `now` — no stored anchor (unlike burst), just like the old calendar month.
function weekBucket(now: number): number {
	return Math.floor((now + MONDAY_ALIGN_MS) / WEEK_MS)
}
function weekResetsAt(bucket: number): number {
	return (bucket + 1) * WEEK_MS - MONDAY_ALIGN_MS
}

// One metered AI window: cost accrued this window, and when it resets (ms epoch). `resetsAt`
// is null only for an idle burst window (nothing spent yet, so no active window to reset).
export interface WindowUsage {
	costUsd: number
	resetsAt: number | null
}

// AI counter across the two windows plus never-reset lifetime totals. `costUsd` is pi's
// estimate from model pricing, NOT the OpenRouter invoice. `requests` counts provider calls
// (a prompt drives several turns); tokens/requests are scoped to the current weekly window.
export interface AiUsage {
	burst: WindowUsage
	weekly: WindowUsage
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

// The reservation's ownership token: which burst/weekly window it belongs to. settle/release
// match these against the row's current keys to prove a window hasn't rolled underneath them.
export interface ReserveHandle {
	burstExpires: number
	weeklyKey: number
}

// Create the one-row counter table (fresh DBs) and migrate a legacy monthly-window table in
// place (add the burst/weekly columns; the shared lifetime/tokens/requests columns carry over,
// old windowed spend is discarded — a one-time reset). Called once per DO boot (in reset()),
// before any request.
export async function ensureUsageSchema(db: DbAdapter): Promise<void> {
	await db.run(
		`CREATE TABLE IF NOT EXISTS usage_ai (
			id INTEGER PRIMARY KEY,
			burst_expires INTEGER NOT NULL DEFAULT 0,
			burst_micros INTEGER NOT NULL DEFAULT 0,
			burst_reserved INTEGER NOT NULL DEFAULT 0,
			weekly_key INTEGER NOT NULL DEFAULT 0,
			weekly_micros INTEGER NOT NULL DEFAULT 0,
			weekly_reserved INTEGER NOT NULL DEFAULT 0,
			tokens INTEGER NOT NULL DEFAULT 0,
			requests INTEGER NOT NULL DEFAULT 0,
			lifetime_micros INTEGER NOT NULL DEFAULT 0,
			lifetime_requests INTEGER NOT NULL DEFAULT 0
		)`
	)
	// A DO created before dual-window caps has the old columns and lacks these; add any that
	// are missing. On such a row all defaults are 0 → burst_expires=0 and weekly_key=0 both
	// roll on the first reserve, so the first window starts clean.
	const cols = new Set(
		(await db.query<{ name: unknown }>('PRAGMA table_info(usage_ai)')).map((r) => String(r.name))
	)
	for (const name of [
		'burst_expires',
		'burst_micros',
		'burst_reserved',
		'weekly_key',
		'weekly_micros',
		'weekly_reserved'
	]) {
		if (!cols.has(name))
			await db.run(`ALTER TABLE usage_ai ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`)
	}
	await db.run('INSERT OR IGNORE INTO usage_ai (id) VALUES (1)')
}

// Clear reservations at DO BOOT only — a fresh instance has no in-flight calls, so any
// non-zero `reserved` is leaked by a prior instance that died between reserve and settle.
// NOT part of ensureUsageSchema: `reset()` also runs on volume wipe/complete WHILE calls may
// be in flight, and those aborts let live calls settle their own reservations (see reset()).
export async function sweepReservations(db: DbAdapter): Promise<void> {
	await db.run('UPDATE usage_ai SET burst_reserved = 0, weekly_reserved = 0 WHERE id = 1')
}

// Atomically admit a call and hold a reservation in BOTH windows, rolling any elapsed window
// in the same statement. One statement ⇒ atomic on the single-threaded DO; concurrent reserves
// each see the prior one's reservation. Returns the reservation's HANDLE (needed by settle/
// release to prove ownership across a roll), or null when either window's budget is spent.
export async function reserve(
	db: DbAdapter,
	now: number,
	estMicros: number,
	burstLimit: number,
	weeklyLimit: number
): Promise<ReserveHandle | null> {
	const wk = weekBucket(now)
	const burstNext = now + BURST_WINDOW_MS
	const rows = await db.query<{ burst_expires: unknown; weekly_key: unknown }>(
		`UPDATE usage_ai SET
			burst_micros    = CASE WHEN ? < burst_expires THEN burst_micros ELSE 0 END,
			burst_reserved  = (CASE WHEN ? < burst_expires THEN burst_reserved ELSE 0 END) + ?,
			burst_expires   = CASE WHEN ? < burst_expires THEN burst_expires ELSE ? END,
			tokens   = CASE WHEN weekly_key = ? THEN tokens ELSE 0 END,
			requests = CASE WHEN weekly_key = ? THEN requests ELSE 0 END,
			weekly_micros   = CASE WHEN weekly_key = ? THEN weekly_micros ELSE 0 END,
			weekly_reserved = (CASE WHEN weekly_key = ? THEN weekly_reserved ELSE 0 END) + ?,
			weekly_key      = ?
		 WHERE id = 1
		   AND (CASE WHEN ? < burst_expires THEN burst_micros + burst_reserved ELSE 0 END) + ? <= ?
		   AND (CASE WHEN weekly_key = ? THEN weekly_micros + weekly_reserved ELSE 0 END) + ? <= ?
		 RETURNING burst_expires, weekly_key`,
		[
			now,
			now,
			estMicros,
			now,
			burstNext,
			wk,
			wk,
			wk,
			wk,
			estMicros,
			wk,
			now,
			estMicros,
			burstLimit,
			wk,
			estMicros,
			weeklyLimit
		]
	)
	const row = rows[0]
	if (!row) return null
	return { burstExpires: Number(row.burst_expires), weeklyKey: Number(row.weekly_key) }
}

// Free the reservation and record the ACTUAL cost, per window. A window's committed/reserved
// change ONLY when it still matches the handle — so a call that spanned a roll can't subtract
// the new window's reservation or inflate its committed (the roll already discarded this
// reservation). Lifetime totals always accrue. One atomic statement.
export async function settle(
	db: DbAdapter,
	handle: ReserveHandle,
	estMicros: number,
	usage: Usage
): Promise<void> {
	const actual = Math.round(usage.cost.total * MICROS_PER_USD)
	await db.run(
		`UPDATE usage_ai SET
			burst_micros    = burst_micros + (CASE WHEN burst_expires = ? THEN ? ELSE 0 END),
			burst_reserved  = MAX(0, burst_reserved - (CASE WHEN burst_expires = ? THEN ? ELSE 0 END)),
			weekly_micros   = weekly_micros + (CASE WHEN weekly_key = ? THEN ? ELSE 0 END),
			weekly_reserved = MAX(0, weekly_reserved - (CASE WHEN weekly_key = ? THEN ? ELSE 0 END)),
			tokens   = tokens + (CASE WHEN weekly_key = ? THEN ? ELSE 0 END),
			requests = requests + (CASE WHEN weekly_key = ? THEN 1 ELSE 0 END),
			lifetime_micros = lifetime_micros + ?,
			lifetime_requests = lifetime_requests + 1
		 WHERE id = 1`,
		[
			handle.burstExpires,
			actual,
			handle.burstExpires,
			estMicros,
			handle.weeklyKey,
			actual,
			handle.weeklyKey,
			estMicros,
			handle.weeklyKey,
			usage.totalTokens,
			handle.weeklyKey,
			actual
		]
	)
}

// Free a reservation for a call that failed before producing usage — per window, only if it
// still matches the handle (a roll already discarded it). Nothing to count.
export async function release(
	db: DbAdapter,
	handle: ReserveHandle,
	estMicros: number
): Promise<void> {
	await db.run(
		`UPDATE usage_ai SET
			burst_reserved  = MAX(0, burst_reserved - (CASE WHEN burst_expires = ? THEN ? ELSE 0 END)),
			weekly_reserved = MAX(0, weekly_reserved - (CASE WHEN weekly_key = ? THEN ? ELSE 0 END))
		 WHERE id = 1`,
		[handle.burstExpires, estMicros, handle.weeklyKey, estMicros]
	)
}

// Read the AI counter as of `now` (an elapsed window reads as zeroed, lifetime carried). Pure
// read — the roll is persisted lazily by reserve/settle.
export async function readAiUsage(db: DbAdapter, now = Date.now()): Promise<AiUsage> {
	const wk = weekBucket(now)
	const [row] = await db.query<{
		burst_expires: unknown
		burst_micros: unknown
		weekly_key: unknown
		weekly_micros: unknown
		tokens: unknown
		requests: unknown
		lifetime_micros: unknown
		lifetime_requests: unknown
	}>('SELECT * FROM usage_ai WHERE id = 1')
	if (!row) {
		return {
			burst: { costUsd: 0, resetsAt: null },
			weekly: { costUsd: 0, resetsAt: weekResetsAt(wk) },
			totalTokens: 0,
			requests: 0,
			lifetimeCostUsd: 0,
			lifetimeRequests: 0
		}
	}
	const burstFresh = now < Number(row.burst_expires)
	const weeklyFresh = Number(row.weekly_key) === wk
	return {
		burst: {
			costUsd: burstFresh ? Number(row.burst_micros) / MICROS_PER_USD : 0,
			resetsAt: burstFresh ? Number(row.burst_expires) : null
		},
		weekly: {
			costUsd: weeklyFresh ? Number(row.weekly_micros) / MICROS_PER_USD : 0,
			resetsAt: weekResetsAt(wk)
		},
		totalTokens: weeklyFresh ? Number(row.tokens) : 0,
		requests: weeklyFresh ? Number(row.requests) : 0,
		lifetimeCostUsd: Number(row.lifetime_micros) / MICROS_PER_USD,
		lifetimeRequests: Number(row.lifetime_requests)
	}
}

// Read the current usage report. `physicalBytes` is supplied by the DO (ctx.storage.sql
// .databaseSize) since this module has no Cloudflare knowledge.
export async function readUsage(
	db: DbAdapter,
	physicalBytes: number,
	now = Date.now()
): Promise<UsageReport> {
	const ai = await readAiUsage(db, now)
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
