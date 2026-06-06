import { CapabilityError, implementCapability } from '@justfiles/app/capabilities'
import {
	type IntegrationCredentialsSchema,
	type IntegrationDescriptor,
	type IntegrationField,
	integrations
} from '@justfiles/app/capabilities/integrations'
import type { TSchema } from 'typebox'
import type { IntegrationStatus, Integrations } from './integrations/registry.ts'

// Host-side `integrations` capability — one unit over the in-memory Integrations
// registry that the existing REST routes also drive. It projects internal
// typebox schemas onto the portable JSON-schema-ish shape the contract exposes.
// Untrusted isolate input is validated before reaching the registry.

export const integrationsCapability = (registry: Integrations) =>
	implementCapability(integrations, {
		list: async () => registry.list().map(toDescriptor),
		connect: async ({ id, accountId, credentials }) => {
			if (typeof id !== 'string' || typeof accountId !== 'string' || !isStringRecord(credentials))
				throw invalid('connect')
			await registry.connect({
				integrationId: id,
				accountId,
				creds: { kind: 'static', static: credentials }
			})
		},
		disconnect: async ({ id, accountId }) => {
			if (typeof id !== 'string' || typeof accountId !== 'string') throw invalid('disconnect')
			await registry.disconnect(id, accountId)
		}
	})

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

function invalid(method: string): CapabilityError {
	return new CapabilityError('CAPABILITY_INVALID_INPUT', 'integrations', method)
}
