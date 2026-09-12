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
	// Opaque cache key for the built runtime: a host caches by this and rebuilds when it
	// changes. It must cover model identity AND — for rotating credentials — a credential
	// generation, so replacing the credential (a fresh sign-in) forces a rebuild instead of
	// reusing a runtime bound to the replaced credential store. Never the token itself.
	revision: string
}
