// One capability-error vocabulary, raised and relayed by every layer — impl,
// registry, proxy, broker. The five codes unify what used to be two fragmented
// sets: the host's UNAVAILABLE/INVALID_INPUT/OFFLINE and the broker's
// DENIED/FAILED. A `CapabilityError` is a plain `Error` whose `message` is the
// code, carrying `capability`/`method` for consumers to branch on (e.g. an
// offline GUI reacting to `CAPABILITY_OFFLINE`). The seam turns it into the
// right wire shape; impls never format errors themselves.

export type CapabilityCode =
	| 'CAPABILITY_UNAVAILABLE'
	| 'CAPABILITY_INVALID_INPUT'
	| 'CAPABILITY_DENIED'
	| 'CAPABILITY_FAILED'
	| 'CAPABILITY_OFFLINE'

export interface WireError {
	message: string
	code?: string
	capability?: string
	method?: string
}

// Plain fields rather than parameter properties: this module is imported as
// source by packages that compile with `erasableSyntaxOnly`.
export class CapabilityError extends Error {
	readonly code: CapabilityCode
	readonly capability?: string
	readonly method?: string

	constructor(code: CapabilityCode, capability?: string, method?: string) {
		super(code)
		this.name = 'CapabilityError'
		this.code = code
		this.capability = capability
		this.method = method
	}
}

export function toWire(error: unknown): WireError {
	if (!(error instanceof Error)) return { message: String(error) }
	const e = error as Error & Partial<WireError>
	return { message: e.message, code: e.code, capability: e.capability, method: e.method }
}

export function fromWire(
	wire: WireError,
	fallback?: { capability?: string; method?: string }
): CapabilityError {
	return new CapabilityError(
		(wire.code ?? wire.message) as CapabilityCode,
		wire.capability ?? fallback?.capability,
		wire.method ?? fallback?.method
	)
}
