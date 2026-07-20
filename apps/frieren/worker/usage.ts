import type { Usage } from '@earendil-works/pi-ai'
import type { DbAdapter } from '@justfiles/core'
import type { KvStorage } from './integrations/storage.ts'

// Per-user usage metering. One `Frieren` DO == one account (FRIEREN.idFromName(userId)),
// so everything here is per-user by construction. AI is a durable counter accrued live
// (the session transcript deliberately drops usage, so it can't be recomputed); storage
// is an on-demand aggregate over `fs_contents` (no maintained counter, can't drift).

const AI_KEY = 'usage/ai'

// The R2 storage_kind in fs_contents (see storage.sqlite.ts STORAGE_R2). Anything else
// in that table is inline SQLite content.
const STORAGE_R2 = 2

// AI inference counter, windowed to the current UTC calendar month (rolled lazily on
// write when the month changes — no cron) plus a never-reset lifetime total. `costUsd`
// is pi's estimate from the model's per-million pricing, NOT the OpenRouter invoice —
// good for internal quota, not authoritative billing. `requests` counts provider calls
// (one user prompt drives several turns via the tool loop), not prompts.
export interface AiUsage {
	window: string // 'YYYY-MM' (UTC)
	input: number
	output: number
	cacheRead: number
	cacheWrite: number
	totalTokens: number
	costUsd: number
	requests: number
	lifetimeCostUsd: number
	lifetimeRequests: number
}

// Point-in-time storage footprint. `logicalBytes` is the user's DEDUPED content (one row
// per unique blob in the content-addressed `fs_contents`) and is the billable metric.
// `physicalBytes` (DO SQLite `databaseSize`) additionally covers the FTS index + sync
// journal + xattrs and EXCLUDES R2, so it's a DO-footprint signal, not the storage bill.
// `r2Bytes` slightly undercounts real R2 until blob GC runs (orphaned blobs linger).
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

function emptyAi(window: string): AiUsage {
	return {
		window,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		costUsd: 0,
		requests: 0,
		lifetimeCostUsd: 0,
		lifetimeRequests: 0
	}
}

// Accrue one completed model call into the durable AI counter. The DO is single-threaded,
// but `get`/`put` await points mean concurrent calls could interleave a read-modify-write —
// the caller (Frieren) serializes accrual through a promise chain so no increment is lost.
export async function accrueAi(storage: KvStorage, usage: Usage): Promise<void> {
	const window = currentWindow()
	const prev = (await storage.get<AiUsage>(AI_KEY)) ?? emptyAi(window)
	// Reset the windowed counters when the month rolls; lifetime totals carry over.
	const base =
		prev.window === window
			? prev
			: {
					...emptyAi(window),
					lifetimeCostUsd: prev.lifetimeCostUsd,
					lifetimeRequests: prev.lifetimeRequests
				}
	await storage.put<AiUsage>(AI_KEY, {
		window,
		input: base.input + usage.input,
		output: base.output + usage.output,
		cacheRead: base.cacheRead + usage.cacheRead,
		cacheWrite: base.cacheWrite + usage.cacheWrite,
		totalTokens: base.totalTokens + usage.totalTokens,
		costUsd: base.costUsd + usage.cost.total,
		requests: base.requests + 1,
		lifetimeCostUsd: base.lifetimeCostUsd + usage.cost.total,
		lifetimeRequests: base.lifetimeRequests + 1
	})
}

// Read the current AI counter (or a zeroed one for this window). Cheap KV get — used by
// the per-turn quota gate, which must not pay for the storage aggregate.
export async function readAiUsage(storage: KvStorage): Promise<AiUsage> {
	return (await storage.get<AiUsage>(AI_KEY)) ?? emptyAi(currentWindow())
}

// Read the current usage report. `physicalBytes` is supplied by the DO (ctx.storage.sql
// .databaseSize) since this module has no Cloudflare knowledge.
export async function readUsage(
	storage: KvStorage,
	db: DbAdapter,
	physicalBytes: number
): Promise<UsageReport> {
	const ai = await readAiUsage(storage)
	const rows = await db.query<{ storage_kind: unknown; bytes: unknown; n: unknown }>(
		'SELECT storage_kind, COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS n FROM fs_contents GROUP BY storage_kind'
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
