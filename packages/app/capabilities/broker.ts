import type { CapabilityBridge } from '../capabilities-bridge.js'
import type { CapabilityFactory } from './core.js'

type IdOf<C> = C extends CapabilityFactory<infer Id, unknown> ? Id : never
type ShapeOf<C> = C extends CapabilityFactory<string, infer Shape> ? Shape : never

type MethodScopes<Shape> = {
	[K in keyof Shape]: string
}

export type CapabilityGrant<Id extends string = string> = {
	capability: Id
	scope: string
	accountId?: string
}

type ProviderResolution = {
	providerId: string
	credentials: unknown
}

type BrokerContext<Id extends string = string> = {
	userId: string
	grants: readonly CapabilityGrant<Id>[]
	resolveAccount(req: {
		capability: Id
		method: string
		input: unknown
		accountId?: string
	}): ProviderResolution | Promise<ProviderResolution | undefined> | undefined
	audit?(event: CapabilityAuditEvent<Id>): void | Promise<void>
}

type CapabilityAuditEvent<Id extends string = string> = {
	capability: Id
	method: string
	accountId?: string
	providerId?: string
	outcome: 'allowed' | 'denied' | 'failed'
	message?: string
}

type CapabilityProvider<Shape> = {
	id: string
	name?: string
	description?: string
	create(credentials: unknown): Shape | Promise<Shape>
}

class CapabilityBrokerError extends Error {
	constructor(
		public readonly code: 'CAPABILITY_DENIED' | 'CAPABILITY_FAILED',
		message: string,
		public readonly capability: string,
		public readonly method: string
	) {
		super(message)
		this.name = 'CapabilityBrokerError'
	}
}

export function defineProviderBackedCapability<
	C extends CapabilityFactory<string, unknown>,
	Id extends IdOf<C> = IdOf<C>,
	Shape extends ShapeOf<C> = ShapeOf<C>
>(config: { capability: C; methodScopes: MethodScopes<Shape> }) {
	const capabilityId = config.capability({ scopes: [] }).id as Id
	const providers = new Map<string, CapabilityProvider<Shape>>()

	function defineProvider<P extends CapabilityProvider<Shape>>(provider: P): P {
		providers.set(provider.id, provider)
		return provider
	}

	function createBroker(ctx: BrokerContext<Id>): CapabilityBridge {
		return {
			async invoke(req) {
				if (req.capability !== capabilityId) {
					throw failed(req.capability, req.method, `wrong broker for capability: ${req.capability}`)
				}
				const scope = (config.methodScopes as Record<string, string | undefined>)[req.method]
				if (!scope) throw failed(capabilityId, req.method, `unknown method: ${req.method}`)
				const accountId = accountIdFrom(req.input)
				if (!hasGrant(ctx.grants, capabilityId, scope, accountId)) {
					await ctx.audit?.({
						capability: capabilityId,
						method: req.method,
						accountId,
						outcome: 'denied',
						message: `missing scope: ${scope}`
					})
					throw denied(capabilityId, req.method, `missing scope: ${scope}`)
				}

				const resolved = await ctx.resolveAccount({
					capability: capabilityId,
					method: req.method,
					input: req.input,
					accountId
				})
				if (!resolved) throw denied(capabilityId, req.method, 'no account available')
				const provider = providers.get(resolved.providerId)
				if (!provider)
					throw failed(capabilityId, req.method, `unknown provider: ${resolved.providerId}`)

				try {
					await ctx.audit?.({
						capability: capabilityId,
						method: req.method,
						accountId,
						providerId: resolved.providerId,
						outcome: 'allowed'
					})
					const impl = await provider.create(resolved.credentials)
					const method = (impl as Record<string, unknown>)[req.method]
					if (typeof method !== 'function') {
						throw new Error(`provider ${provider.id} does not implement ${req.method}`)
					}
					return await method.call(impl, req.input)
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error)
					await ctx.audit?.({
						capability: capabilityId,
						method: req.method,
						accountId,
						providerId: resolved.providerId,
						outcome: 'failed',
						message
					})
					throw failed(capabilityId, req.method, message)
				}
			}
		}
	}

	return { defineProvider, createBroker }
}

function accountIdFrom(input: unknown): string | undefined {
	if (!input || typeof input !== 'object') return undefined
	const accountId = (input as { accountId?: unknown }).accountId
	return typeof accountId === 'string' ? accountId : undefined
}

function hasGrant<Id extends string>(
	grants: readonly CapabilityGrant<Id>[],
	capability: Id,
	scope: string,
	accountId?: string
): boolean {
	return grants.some(
		(grant) =>
			grant.capability === capability &&
			grant.scope === scope &&
			(grant.accountId === undefined || grant.accountId === accountId)
	)
}

function denied(capability: string, method: string, message: string): CapabilityBrokerError {
	return new CapabilityBrokerError('CAPABILITY_DENIED', message, capability, method)
}

function failed(capability: string, method: string, message: string): CapabilityBrokerError {
	return new CapabilityBrokerError('CAPABILITY_FAILED', message, capability, method)
}
