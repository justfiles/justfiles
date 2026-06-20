import type { StreamFn } from '@mariozechner/pi-agent-core'
import { type Api, completeSimple, type Model, streamSimple } from '@mariozechner/pi-ai'

export type LLMConfig = {
	model: Model<Api>
	apiKey: string
}

export type CompleteFn = (
	...args: Parameters<typeof completeSimple>
) => ReturnType<typeof completeSimple>

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

// Wrap a raw apiKey into a backend; the key lives only inside the closures. The
// plain-key callers (local LM Studio, env-keyed hosts) route through here.
export function apiKeyBackend({ model, apiKey }: LLMConfig): AgentBackend {
	return {
		model,
		streamFn: (m, context, options) => streamSimple(m, context, { ...options, apiKey }),
		completeFn: (m, context, options) => completeSimple(m, context, { ...options, apiKey }),
		revision: fingerprint(apiKey)
	}
}

// Normalise either form to a backend, so `createAgent`/`text` accept a raw config
// or a host-minted, token-sealed backend interchangeably.
export function toBackend(config: LLMConfig | AgentBackend): AgentBackend {
	return 'streamFn' in config ? config : apiKeyBackend(config)
}

// Non-cryptographic fingerprint (djb2) — a cache key, not a secret: lets a
// refreshed token rotate the runtime cache key without surfacing the token.
function fingerprint(s: string): string {
	let h = 5381
	for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0
	return h.toString(36)
}
