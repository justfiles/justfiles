import type { StreamFn } from '@earendil-works/pi-agent-core'
import type { Api, Model, Models } from '@earendil-works/pi-ai'

// The completion signature, sourced from pi's `Models` so the backend and the text
// helpers agree without touching the deprecated `/compat` surface.
export type CompleteFn = Models['completeSimple']

// What the runtime needs to drive a model. `streamFn`/`completeFn` are the
// credential seam: a host mints them with the token captured in the closure, so
// the agent loop and the text helpers run through them but never hold the secret —
// the accounts → capability rule of "vend an operation, not the secret" (ssh-agent,
// not a key handout).
export type AgentBackend = {
	model: Model<Api>
	streamFn: StreamFn
	completeFn: CompleteFn
	// Opaque revision that rotates with the credential, so a host can cache-key its
	// runtime and rebuild on token refresh without ever reading the token.
	revision: string
}

// Wrap a pi `Models` collection into a backend: the agent loop and text helpers stream
// through `Models`, which resolves auth and refreshes credentials internally (under its
// credential-store lock) — so the token never sits on the backend, and a refresh needs
// no rebuild. `revision` is stable (model identity). This is the sole backend seam: the
// host builds a `Models` (over a `CredentialStore`), the agent drives it, and neither
// holds the token.
export function modelsBackend(models: Models, model: Model<Api>): AgentBackend {
	return {
		model,
		streamFn: (m, context, options) => models.streamSimple(m, context, options),
		completeFn: (m, context, options) => models.completeSimple(m, context, options),
		revision: `${model.provider}:${model.id}`
	}
}
