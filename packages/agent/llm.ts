import type { StreamFn } from '@earendil-works/pi-agent-core'
import type { Api, Model, Models, Usage } from '@earendil-works/pi-ai'

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

// Passive usage meter: decorate a backend so every COMPLETED model call reports its
// `Usage` to `onUsage`, covering every text call that flows through the backend —
// agent turns, soul generation, and daily maintenance. Purely observational: it never
// alters the stream the agent loop consumes (the stream path reads the terminal
// AssistantMessage via `.result()` rather than draining the async iterator), and a
// metering failure is swallowed so it can never break a turn. No accrual/quota logic
// lives here — the host owns the durable counter. (Image generation runs on a separate
// `ImagesModels` stack and is metered at its own call site, not here.)
export function meterBackend(backend: AgentBackend, onUsage: (usage: Usage) => void): AgentBackend {
	return {
		...backend,
		streamFn: async (m, context, options) => {
			const stream = await backend.streamFn(m, context, options)
			stream
				.result()
				.then((msg) => onUsage(msg.usage))
				.catch(() => {})
			return stream
		},
		completeFn: async (m, context, options) => {
			const msg = await backend.completeFn(m, context, options)
			onUsage(msg.usage)
			return msg
		}
	}
}
