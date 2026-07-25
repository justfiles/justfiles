// Host-side helper for the `ai` capability's purpose-scoped context projections
// (issue #272). This is the permission boundary: it enforces the `context:*`
// scope and prepends the HOST-composed fragment to the app's system prompt, so
// the projection and composed prompt never cross into the app AS DATA (params,
// state, or the `{ text }` result the host builds). The composer itself (which
// reads the Volume + credentialed model) is INJECTED by the host, keeping this
// app layer free of any agent/provider dependency.
//
// Per #272, a system prompt is NOT a security boundary against the model: a
// scope-bearing app can craft `system`/`prompt` to coax the model into echoing
// the fragment back in its output. That is an accepted, bounded risk because the
// fragment carries only disclosure-safe adaptation hints — a coarse age plus the
// sanitized, PII-free learning projection (the extraction prompt + payload caps
// exclude names, birth dates, gender, location, contacts, and sensitive facts).
// Nothing an echo could surface is more sensitive than what the app already
// influenced. True isolation is impossible over a single-system-message model
// call, so the guarantee is disclosure-safety, not echo-resistance.

import { CapabilityError } from '../error.ts'

// A context kind → its composer. The composer returns the prompt-safe fragment
// ('' when neutral) and must never throw — a projection miss degrades to neutral
// context, never a failed generation. Add a key only with its own scope.
export interface ContextComposers {
	learning?: () => Promise<string>
}

// Resolve the system prompt for a (possibly scoped) `generateText` call. Without
// `context` this is just the app's own system string. With `context: 'learning'`
// it requires the `context:learning` scope (else CAPABILITY_DENIED) and prepends
// the composed fragment. Any other `context` value is INVALID_INPUT.
export async function composeSystem(
	ctx: { scopes: readonly string[] },
	input: { system?: unknown; context?: unknown },
	composers?: ContextComposers
): Promise<string> {
	const base = typeof input.system === 'string' ? input.system : ''
	if (input.context === undefined) return base
	if (input.context !== 'learning')
		throw new CapabilityError('CAPABILITY_INVALID_INPUT', 'ai', 'generateText')
	if (!ctx.scopes.includes('context:learning'))
		throw new CapabilityError('CAPABILITY_DENIED', 'ai', 'generateText')
	const composed = (await composers?.learning?.()) ?? ''
	return composed ? `${composed}\n\n${base}` : base
}
