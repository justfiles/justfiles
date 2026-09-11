import { CapabilityError } from './capabilities/error.ts'
import type { CapabilityCall } from './capabilities/types.ts'

type AppId = string

export async function workspaceGrant(
	resolve: CapabilityResolver['resolve'],
	appId: string,
	id: string,
	method: string,
	args: readonly unknown[]
): Promise<CapabilityCall['workspace']> {
	if (id !== 'ai' || method !== 'runAgent') return undefined
	const input = args[0] as { workspace?: { capability?: unknown } } | undefined
	if (input?.workspace === undefined) return undefined
	const name = input.workspace?.capability
	if (typeof name !== 'string') throw new CapabilityError('CAPABILITY_INVALID_INPUT', 'ai', method)
	const grant = await resolve(appId, name)
	if (grant?.id !== 'volume') throw new CapabilityError('CAPABILITY_DENIED', 'ai', method)
	return { capability: name, scopes: grant.scopes }
}

// A capability's trusted identity: the host capability `id` and the DECLARED
// scopes the kernel attaches to every call. Resolved from the app's bundle —
// never from anything the isolate forwards.
export type Declared = { id: string; scopes: readonly string[] }

// The capability resolver: the single trust boundary mapping an app's LOCAL
// capability name (the key it declared) to its trusted { id, scopes }. The kernel
// attaches the resolved scopes to host invocations and stream opens, so a
// compromised isolate can neither escalate scope nor reach a capability it never
// declared. Declarations are read from the bundle once and memoized; the memo is
// dropped on (re)install/uninstall, since a new bundle may declare differently.
export interface CapabilityResolver {
	// The trusted { id, scopes } for a local name, or undefined if the app never
	// declared it (the caller surfaces that as an undeclared-capability error).
	resolve(appId: AppId, name: string): Promise<Declared | undefined>
	// Drop the memoized declarations for an app.
	forget(appId: AppId): void
	// Drop every declaration when the owning kernel is disposed.
	clear(): void
}

// `load` reads an app's declarations from its bundle (local name → { id, scopes }).
// Injected so the resolver stays decoupled from how bundles are loaded.
export function capabilityResolver(
	load: (appId: AppId) => Promise<Record<string, Declared>>
): CapabilityResolver {
	// Per-app declarations, memoized as a shared promise so concurrent first
	// callers resolve against a single load.
	const declared = new Map<AppId, Promise<Record<string, Declared>>>()

	function all(appId: AppId): Promise<Record<string, Declared>> {
		let cached = declared.get(appId)
		if (!cached) {
			cached = load(appId)
			declared.set(appId, cached)
		}
		return cached
	}

	return {
		async resolve(appId, name) {
			return (await all(appId))[name]
		},
		forget(appId) {
			declared.delete(appId)
		},
		clear() {
			declared.clear()
		}
	}
}
