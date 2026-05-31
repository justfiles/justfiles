// One capability-error shape, shared by every context that raises or relays a
// capability failure: the volume capability, the server proxy boundary, the
// browser sandbox host, and the client capability bridge. (The sandbox *worker*
// keeps its own inline copies — it's a separate execution context loaded as a
// string and can't import.)
//
// A capability error is a plain `Error` whose `message` is the code, carrying
// `code`/`capability`/`method` for the consumer to branch on (e.g. an offline
// GUI reacting to `CAPABILITY_OFFLINE`).

export interface WireError {
	message: string
	code?: string
	capability?: string
	method?: string
}

export function capabilityError(code: string, capability?: string, method?: string): Error {
	return Object.assign(new Error(code), { code, capability, method })
}

export function toWireError(error: unknown): WireError {
	if (!(error instanceof Error)) return { message: String(error) }
	const e = error as Error & WireError
	return { message: e.message, code: e.code, capability: e.capability, method: e.method }
}

export function fromWireError(
	wire: WireError,
	fallback?: { capability?: string; method?: string }
): Error {
	return Object.assign(new Error(wire.message), {
		code: wire.code,
		capability: wire.capability ?? fallback?.capability,
		method: wire.method ?? fallback?.method
	})
}
