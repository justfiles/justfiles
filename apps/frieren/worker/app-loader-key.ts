// Pure helpers shared between the host runtime (`app-bridge.ts`) and tests.
// Kept free of cloudflare:workers imports so the test config can typecheck
// it without pulling the Workers ambient declarations through the worker
// tsconfig.

import type { CapabilityGrant } from '@justfiles/app/capabilities/broker'
import type { CapabilityBridge } from '@justfiles/app/capabilities-bridge.js'

/**
 * Per-mount runtime context handed to `loadAppFacet`. Encodes who the
 * sandbox runs for, what they're allowed to do, and the broker that
 * services those calls. `userId` and `grants` flow into the loader cache
 * key so a sandbox can never be reused across different users or grant
 * sets.
 */
export type AppFacetScope = {
	userId: string
	grants: readonly CapabilityGrant[]
	bridge: CapabilityBridge
}

/**
 * Deterministic loader cache key. Encodes app id, app version, user id,
 * and a stable hash of the grants set so loaded sandboxes are isolated
 * across versions, users, and grant changes.
 */
export function appLoaderCacheKey(args: {
	appId: string
	version: string
	userId: string
	grants: readonly CapabilityGrant[]
}): string {
	return `${args.appId}:${args.version}:${args.userId}:${grantsHash(args.grants)}`
}

// Stable, order-independent hash of a grant set.
function grantsHash(grants: readonly CapabilityGrant[]): string {
	const parts = grants.map((g) => `${g.capability}|${g.scope}|${g.accountId ?? ''}`).sort()
	return fnv1a(parts.join('\n')).toString(16)
}

function fnv1a(s: string): number {
	let h = 0x811c9dc5
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i)
		h = Math.imul(h, 0x01000193) >>> 0
	}
	return h >>> 0
}
