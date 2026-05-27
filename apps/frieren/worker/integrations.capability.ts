import type {
	IntegrationCredentialsSchema,
	IntegrationDescriptor,
	IntegrationField
} from '@justfiles/app/capabilities/integrations'
import type { TSchema } from 'typebox'
import type { IntegrationStatus, Integrations } from './integrations/registry.ts'

// Host-side `integrations` capability handler. Delegates to the in-memory
// Integrations registry that the existing REST routes also drive, and
// projects internal typebox schemas onto the portable JSON-schema-ish shape
// the capability contract exposes.

export async function invokeIntegrations(
	registry: Integrations,
	req: { method: string; input: unknown }
): Promise<unknown> {
	switch (req.method) {
		case 'list':
			return registry.list().map(toDescriptor)
		case 'connect': {
			const input = (req.input ?? {}) as {
				id?: unknown
				accountId?: unknown
				credentials?: unknown
			}
			if (
				typeof input.id !== 'string' ||
				typeof input.accountId !== 'string' ||
				!isStringRecord(input.credentials)
			)
				throw invalid(req.method)
			await registry.connect({
				integrationId: input.id,
				accountId: input.accountId,
				creds: { kind: 'static', static: input.credentials }
			})
			return undefined
		}
		case 'disconnect': {
			const input = (req.input ?? {}) as { id?: unknown; accountId?: unknown }
			if (typeof input.id !== 'string' || typeof input.accountId !== 'string')
				throw invalid(req.method)
			await registry.disconnect(input.id, input.accountId)
			return undefined
		}
		default:
			throw unavailable(req.method)
	}
}

function toDescriptor(status: IntegrationStatus): IntegrationDescriptor {
	return {
		id: status.id,
		name: status.name,
		description: status.description,
		credentialsSchema: toCredentialsSchema(status.credentialsSchema),
		connectedAccounts: status.connectedAccounts
	}
}

function toCredentialsSchema(schema: TSchema): IntegrationCredentialsSchema {
	// Typebox object schemas are already JSON-Schema-shaped; project the
	// fields the app needs and drop everything else.
	const s = schema as unknown as {
		type?: unknown
		properties?: Record<string, unknown>
		required?: unknown
	}
	const properties: Record<string, IntegrationField> = {}
	for (const [key, raw] of Object.entries(s.properties ?? {})) {
		const field = raw as { type?: unknown; minLength?: unknown; description?: unknown }
		if (field.type !== 'string') continue
		properties[key] = {
			type: 'string',
			minLength: typeof field.minLength === 'number' ? field.minLength : undefined,
			description: typeof field.description === 'string' ? field.description : undefined
		}
	}
	return {
		type: 'object',
		properties,
		required: Array.isArray(s.required) ? (s.required as string[]) : undefined
	}
}

function isStringRecord(value: unknown): value is Record<string, string> {
	if (!value || typeof value !== 'object') return false
	return Object.values(value as Record<string, unknown>).every((v) => typeof v === 'string')
}

function invalid(method: string): Error {
	return Object.assign(new Error('CAPABILITY_INVALID_INPUT'), {
		code: 'CAPABILITY_INVALID_INPUT',
		capability: 'integrations',
		method
	})
}

function unavailable(method: string): Error {
	return Object.assign(new Error('CAPABILITY_UNAVAILABLE'), {
		code: 'CAPABILITY_UNAVAILABLE',
		capability: 'integrations',
		method
	})
}
