import type { CapabilityGrant, SandboxContext } from './contracts.ts'

// Stable, deterministic hash of grants. Platform-agnostic — uses FNV-1a so
// the same grant set always produces the same cache key regardless of grant
// ordering or scope key ordering.
export function hashGrants(grants: ReadonlyArray<CapabilityGrant>): string {
	const canonical = JSON.stringify(grants.map(canonicalGrant).sort(compareCanonical))
	let h = 0x811c9dc5
	for (let i = 0; i < canonical.length; i++) {
		h ^= canonical.charCodeAt(i)
		h = Math.imul(h, 0x01000193) >>> 0
	}
	return h.toString(16).padStart(8, '0')
}

export function sandboxCacheKey(ctx: SandboxContext): string {
	return `${ctx.appId}:${ctx.appVersion}:${ctx.userId}:${hashGrants(ctx.grants)}`
}

function canonicalGrant(g: CapabilityGrant): unknown[] {
	const scope = g.scope ? canonicalRecord(g.scope) : null
	return [g.name, g.accountId ?? '', scope]
}

function canonicalRecord(r: Record<string, unknown>): Array<[string, unknown]> {
	return Object.keys(r)
		.sort()
		.map((k) => [k, r[k]])
}

function compareCanonical(a: unknown[], b: unknown[]): number {
	const sa = JSON.stringify(a)
	const sb = JSON.stringify(b)
	return sa < sb ? -1 : sa > sb ? 1 : 0
}
