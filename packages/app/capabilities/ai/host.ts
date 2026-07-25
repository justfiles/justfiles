// Host-side helper for the `ai` capability's purpose-scoped context projections
// (issue #272). This is the permission boundary: it enforces the `context:*`
// scope and prepends the HOST-composed fragment to the app's system prompt, so
// raw profile/memory and the composed prompt never cross into the app. The
// composer itself (which reads the Volume + credentialed model) is INJECTED by
// the host, keeping this app layer free of any agent/provider dependency.

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
