// Generic RPC pipe for host services exposed to client-only apps. Iframe
// → AppFrame → useChat → DO carry a `{method, params}` request; the DO
// looks up a typed handler and returns its result. Adding a new API is
// one entry in `HostMethods` (the shared contract) plus one handler
// registered in the DO — no changes elsewhere in the transport.

import type { HostMethod, HostMethods } from '@justfiles/app/host-methods'
import type { Volume } from '@justfiles/fs'

export interface HostContext {
	readonly vol: Volume
	readonly appId: string
}

export type HostHandler<M extends HostMethod> = (
	params: HostMethods[M]['params'],
	ctx: HostContext
) => Promise<HostMethods[M]['result']>

export type HostHandlers = { [M in HostMethod]: HostHandler<M> }

/** Stable error code on the wire. Handlers throw HostMethodError; everything
 *  else surfaces as the underlying error message. */
export class HostMethodError extends Error {
	readonly code: string
	constructor(code: string, message: string) {
		super(`${code}: ${message}`)
		this.code = code
		this.name = 'HostMethodError'
	}
}

export async function dispatchHostRpc(
	registry: HostHandlers,
	method: string,
	params: unknown,
	ctx: HostContext
): Promise<unknown> {
	if (!Object.hasOwn(registry, method)) {
		throw new HostMethodError('EMETHOD', `unknown host method: ${method}`)
	}
	const handler = (registry as Record<string, (p: unknown, c: HostContext) => Promise<unknown>>)[
		method
	]
	if (!handler) throw new HostMethodError('EMETHOD', `unknown host method: ${method}`)
	return handler(params, ctx)
}
