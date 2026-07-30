import type { Usage } from '@earendil-works/pi-ai'
import type { DbAdapter } from '@justfiles/core'
import type { KvStorage } from './integrations/storage.ts'
import { type AdmitHandle, admit, MICROS_PER_USD, record, type UsageReport } from './usage.ts'

// Free-vs-paid caps. A cap is a ceiling on the billable metrics the meter produces: AI cost
// per window and deduped logical storage bytes. AI is capped in TWO windows, Claude-Code
// style — a short rolling "burst" window and a fixed weekly window — so a user can't burn a
// whole week's budget in one sitting. A tier is a named set of caps — add entries to TIERS to
// introduce new tiers; the Limits SHAPE never changes, so there is no data migration. `null`
// means unlimited (JSON-safe, unlike Infinity).

export interface Limits {
	aiBurstUsd: number | null // max AI cost (USD) per rolling burst window
	aiWeeklyUsd: number | null // max AI cost (USD) per weekly window
	storageBytes: number | null // max logical (deduped) storage bytes — point-in-time gauge
}

export type TierId = 'free' | 'pro' | 'unlimited'

const MB = 1024 * 1024
const GB = 1024 * MB

// ── The single source of truth for caps. Adjust numbers here; ships on deploy. ──
// Free values are starting points to validate in practice, not final.
export const TIERS: Record<TierId, Limits> = {
	free: { aiBurstUsd: 0.35, aiWeeklyUsd: 1, storageBytes: 500 * MB },
	pro: { aiBurstUsd: 2, aiWeeklyUsd: 6, storageBytes: 25 * GB },
	// No caps. Not assigned by billing — reserved for a local-dev override (see readTier).
	unlimited: { aiBurstUsd: null, aiWeeklyUsd: null, storageBytes: null }
}

export const DEFAULT_TIER: TierId = 'free'

// One KV key per user DO holds the assigned tier; the billing hook (Stripe → Clerk →
// setTier) writes it later. Absent/unknown falls back to the free default.
const TIER_KEY = 'usage/tier'

function limitsFor(tier: TierId): Limits {
	return TIERS[tier] ?? TIERS[DEFAULT_TIER]
}

// `override` (the resolved dev-only tier — see DEV_TIER_OVERRIDE in worker/frieren.ts) wins
// over the stored tier, so local dev can lift the free cap without touching billing state.
export async function readTier(storage: KvStorage, override?: string): Promise<TierId> {
	if (override && override in TIERS) return override as TierId
	const tier = await storage.get<TierId>(TIER_KEY)
	return tier && tier in TIERS ? tier : DEFAULT_TIER
}

export async function setTier(storage: KvStorage, tier: TierId): Promise<void> {
	await storage.put<TierId>(TIER_KEY, tier)
}

export interface Quota {
	used: number
	limit: number | null
	remaining: number | null // null = unlimited
	exceeded: boolean
	fraction: number // used / limit → drives a UI progress bar; 0 when unlimited
}

// An AI window's quota plus when it resets (ms epoch; null = an idle burst window).
export interface AiWindowQuota extends Quota {
	resetsAt: number | null
}

function evalQuota(used: number, limit: number | null): Quota {
	if (limit == null) return { used, limit: null, remaining: null, exceeded: false, fraction: 0 }
	return {
		used,
		limit,
		remaining: Math.max(0, limit - used),
		exceeded: used >= limit,
		fraction: limit === 0 ? 1 : used / limit
	}
}

// The AI caps as micro-USD for the admit gate (`null` = unlimited ⇒ no gating on that
// window). The store works in integer micros; USD only surfaces in the display quota below.
export function aiLimitsMicros(tier: TierId): { burst: number | null; weekly: number | null } {
	const l = limitsFor(tier)
	return {
		burst: l.aiBurstUsd === null ? null : Math.round(l.aiBurstUsd * MICROS_PER_USD),
		weekly: l.aiWeeklyUsd === null ? null : Math.round(l.aiWeeklyUsd * MICROS_PER_USD)
	}
}

export interface QuotaReport {
	tier: TierId
	aiBurst: AiWindowQuota
	aiWeekly: AiWindowQuota
	storage: Quota
}

// The one admit -> run -> record seam, shared by the agent's own metered backend
// (`Frieren.meteredBackend`) and the `/api/ai` gateway — so a platform-key call is billed
// exactly the same way regardless of which caller made it. `admitOrThrow` re-reads the tier
// on every call (a plan change takes effect on the next request, not the next deploy).
export interface AiMeter {
	admitOrThrow(): Promise<AdmitHandle>
	record(handle: AdmitHandle, usage: Usage): Promise<void>
}

// Thrown ONLY for the intentional case — `admit` found the cap already spent. Callers (the
// gateway) key off this type, not "admitOrThrow threw", to tell an over-quota user apart from
// an operational failure (KV/SQLite unavailable): the tier read or the SQLite admit statement
// can reject for reasons that have nothing to do with the user's quota, and reporting THOSE as
// "you're over quota, upgrade or wait" is a wrong diagnosis a client would act on incorrectly.
export class QuotaExceededError extends Error {}

export function createAiMeter(
	db: DbAdapter,
	storage: KvStorage,
	devTierOverride?: string
): AiMeter {
	return {
		async admitOrThrow() {
			const limits = aiLimitsMicros(await readTier(storage, devTierOverride))
			const handle = await admit(
				db,
				Date.now(),
				limits.burst ?? Number.MAX_SAFE_INTEGER,
				limits.weekly ?? Number.MAX_SAFE_INTEGER
			)
			if (handle === null)
				throw new QuotaExceededError('AI limit reached — it resets soon, or upgrade your plan.')
			return handle
		},
		record: (handle, usage) => record(db, handle, usage)
	}
}

export function evaluate(usage: UsageReport, tier: TierId): QuotaReport {
	const limits = limitsFor(tier)
	return {
		tier,
		aiBurst: {
			...evalQuota(usage.ai.burst.costUsd, limits.aiBurstUsd),
			resetsAt: usage.ai.burst.resetsAt
		},
		aiWeekly: {
			...evalQuota(usage.ai.weekly.costUsd, limits.aiWeeklyUsd),
			resetsAt: usage.ai.weekly.resetsAt
		},
		storage: evalQuota(usage.storage.logicalBytes, limits.storageBytes)
	}
}
