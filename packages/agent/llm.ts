import type { Api, Model, Models } from '@earendil-works/pi-ai'
import type { AgentBackend } from '@justfiles/app/capabilities/ai/host'

export type { AgentBackend, CompleteFn } from '@justfiles/app/capabilities/ai/host'

// Wrap a pi `Models` collection into a backend: the agent loop and text helpers stream
// through `Models`, which resolves auth and refreshes credentials internally (under its
// credential-store lock) — so the token never sits on the backend, and an ordinary refresh
// needs no rebuild. `credentialRevision` lets a host with ROTATING credentials fold a
// non-secret generation (e.g. the token's expiry) into the revision, so a credential
// *replacement* (re-sign-in) rotates the cache key and the session rebuilds — losslessly —
// over the new credentials; static-key hosts omit it and keep a stable revision. This is
// the sole backend seam: the host builds a `Models` (over a `CredentialStore`), the agent
// drives it, and neither holds the token.
export function modelsBackend(
	models: Models,
	model: Model<Api>,
	credentialRevision = ''
): AgentBackend {
	const base = `${model.provider}:${model.id}`
	return {
		model,
		streamFn: (m, context, options) => models.streamSimple(m, context, options),
		completeFn: (m, context, options) => models.completeSimple(m, context, options),
		revision: credentialRevision ? `${base}:${credentialRevision}` : base
	}
}
