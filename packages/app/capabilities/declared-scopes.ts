// The `_caps` wire deliberately strips scopes (see rpc.ts) — a client cannot be
// trusted to claim them. A host that serves proxied capabilities DIRECTLY over
// the wire (not through its kernel, e.g. frieren's worker) must therefore
// re-resolve each app's TRUSTED scopes before invoking, or every scope check
// sees an empty list and denies. Scopes come from the app's own manifest
// (`/applications/<id>/manifest.json`) — the same author-declared, consent-gated
// decls the store shows — matched by the resolved capability id the wire carries.

import type { Volume } from '@justfiles/fs'
import type { Capabilities, CapabilityCall } from './types.ts'

// Wrap a served `Capabilities` so every call is re-stamped with the caller's
// manifest-declared scopes (never the wire-supplied ones). Undeclared/unknown ⇒
// empty, exactly as if the app declared no scopes.
export function withDeclaredScopes(fs: Volume, inner: Capabilities): Capabilities {
	const attach = async (call: CapabilityCall): Promise<CapabilityCall> => ({
		...call,
		scopes: await declaredScopes(fs, call.appId, call.capability)
	})
	return {
		invoke: async (call) => inner.invoke(await attach(call)),
		subscribe: async (call, emit) => inner.subscribe(await attach(call), emit)
	}
}

async function declaredScopes(
	fs: Volume,
	appId: string,
	capabilityId: string
): Promise<readonly string[]> {
	try {
		const path = `/applications/${appId}/manifest.json`
		if (!(await fs.exists(path))) return []
		const manifest = JSON.parse(new TextDecoder().decode(await fs.readFile(path))) as {
			capabilities?: Record<string, { id?: string; scopes?: readonly string[] } | undefined>
		}
		// An app names each capability locally, but the wire carries the resolved id;
		// union the scopes of every declaration that resolves to it (the common case
		// is a single declaration). Union is safe: all decls are from one app's own
		// consent-gated manifest.
		const scopes = new Set<string>()
		for (const decl of Object.values(manifest.capabilities ?? {}))
			if (decl?.id === capabilityId) for (const s of decl.scopes ?? []) scopes.add(s)
		return [...scopes]
	} catch {
		return []
	}
}
