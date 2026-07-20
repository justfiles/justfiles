// The signed-in user's metered resource usage against their plan — a read-only
// "how much have I used" facet, the sibling of `user` ("who am I"). Host-agnostic
// by design: the frieren host maps its server-side usage + quota into this shape;
// another host can implement it differently. Progressive — grow the fields; the one
// method never changes.

// One metered resource: what's used, the cap (null = unlimited), and derived headroom.
// `used`/`limit`/`remaining` are in the resource's natural unit (USD for AI, bytes for
// storage). `fraction` is used/limit (0 when unlimited) — for a progress bar.
export interface UsageResource {
	used: number
	limit: number | null
	remaining: number | null
	exceeded: boolean
	fraction: number
}

export interface UsageSnapshot {
	// The plan the caps come from (e.g. 'free', 'pro').
	tier: string
	// AI inference cost (USD) accrued in the current monthly window.
	ai: UsageResource
	// Logical (deduped) storage bytes — a point-in-time gauge.
	storage: UsageResource
	// Extra AI detail for display (not capped): tokens + provider requests this window.
	aiTokens: number
	aiRequests: number
	// The current AI window, 'YYYY-MM'.
	window: string
}

export interface UsageCapability {
	// The current usage snapshot for the signed-in account.
	current(input: Record<string, never>): Promise<UsageSnapshot>
}
