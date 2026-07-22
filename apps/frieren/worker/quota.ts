import type { KvStorage } from './integrations/storage.ts'
import { MICROS_PER_USD, type UsageReport } from './usage.ts'

// Free-vs-paid caps. A cap is a ceiling on exactly the two billable metrics the meter
// produces: AI cost per monthly window, and deduped logical storage bytes. A tier is a
// named cap — add entries to TIERS to introduce new tiers; the Limits SHAPE never changes,
// so there is no data migration. `null` means unlimited (JSON-safe, unlike Infinity).

export interface Limits {
	aiCostUsd: number | null // max AI cost (USD) accrued per monthly window
	storageBytes: number | null // max logical (deduped) storage bytes — point-in-time gauge
}

export type TierId = 'free' | 'pro' | 'unlimited'

const MB = 1024 * 1024
const GB = 1024 * MB

// ── The single source of truth for caps. Adjust numbers here; ships on deploy. ──
// Free values are starting points to validate in practice, not final.
export const TIERS: Record<TierId, Limits> = {
	free: { aiCostUsd: 1, storageBytes: 500 * MB },
	pro: { aiCostUsd: 25, storageBytes: 25 * GB },
	// No caps. Not assigned by billing — reserved for a local-dev override (see readTier).
	unlimited: { aiCostUsd: null, storageBytes: null }
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

// The AI cap as micro-USD for the reserve gate (`null` = unlimited ⇒ no gating). The store
// works in integer micros; USD only surfaces in the display quota below.
export function aiLimitMicros(tier: TierId): number | null {
	const usd = limitsFor(tier).aiCostUsd
	return usd === null ? null : Math.round(usd * MICROS_PER_USD)
}

export interface QuotaReport {
	tier: TierId
	ai: Quota
	storage: Quota
}

export function evaluate(usage: UsageReport, tier: TierId): QuotaReport {
	const limits = limitsFor(tier)
	return {
		tier,
		ai: evalQuota(usage.ai.costUsd, limits.aiCostUsd),
		storage: evalQuota(usage.storage.logicalBytes, limits.storageBytes)
	}
}
