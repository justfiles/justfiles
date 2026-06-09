import { CommandRegistry } from '@justfiles/agent'
import type { CapabilityCall } from '@justfiles/app/capabilities'
import Type from 'typebox'
import { describe, expect, test } from 'vitest'
import { type Integration, Integrations } from './integrations/registry.ts'
import { ConnectionStore, type KvStorage } from './integrations/storage.ts'
import { integrationsCapability } from './integrations.capability.ts'

const call = (method: string, input: unknown): CapabilityCall => ({
	appId: 'app',
	capability: 'integrations',
	method,
	args: [input],
	scopes: []
})

function memKv(): KvStorage {
	const map = new Map<string, unknown>()
	return {
		async get<T>(key: string) {
			return map.get(key) as T | undefined
		},
		async put<T>(key: string, value: T) {
			map.set(key, value)
		},
		async delete(key: string) {
			return map.delete(key)
		},
		async list<T>(opts?: { prefix?: string }) {
			const out = new Map<string, T>()
			for (const [k, v] of map) {
				if (!opts?.prefix || k.startsWith(opts.prefix)) out.set(k, v as T)
			}
			return out
		}
	}
}

function fastmail(): Integration {
	return {
		id: 'fastmail',
		name: 'Fastmail',
		description: 'Email via JMAP',
		credentialsSchema: Type.Object({
			token: Type.String({ minLength: 1, description: 'API token' })
		}),
		commands: () => []
	}
}

function setup() {
	const commands = new CommandRegistry()
	const connections = new ConnectionStore(memKv(), 'test-key')
	const registry = new Integrations({ commands, connections })
	registry.define(fastmail())
	return { registry, cap: integrationsCapability(registry) }
}

describe('integrations capability', () => {
	test('list projects the registry payload onto the portable descriptor shape', async () => {
		const { cap } = setup()
		const result = await cap.invoke(call('list', {}))
		expect(result).toEqual([
			{
				id: 'fastmail',
				name: 'Fastmail',
				description: 'Email via JMAP',
				credentialsSchema: {
					type: 'object',
					properties: {
						token: { type: 'string', minLength: 1, description: 'API token' }
					},
					required: ['token']
				},
				connectedAccounts: []
			}
		])
	})

	test('connect adds a connected account that list reflects', async () => {
		const { cap } = setup()
		await cap.invoke(
			call('connect', { id: 'fastmail', accountId: 'primary', credentials: { token: 'abc' } })
		)
		const result = (await cap.invoke(call('list', {}))) as Array<{
			connectedAccounts: ReadonlyArray<{ accountId: string }>
		}>
		expect(result[0]?.connectedAccounts).toEqual([{ accountId: 'primary' }])
	})

	test('disconnect removes a connected account', async () => {
		const { cap } = setup()
		await cap.invoke(
			call('connect', { id: 'fastmail', accountId: 'primary', credentials: { token: 'abc' } })
		)
		await cap.invoke(call('disconnect', { id: 'fastmail', accountId: 'primary' }))
		const result = (await cap.invoke(call('list', {}))) as Array<{ connectedAccounts: unknown[] }>
		expect(result[0]?.connectedAccounts).toEqual([])
	})

	test('rejects malformed connect input', async () => {
		const { cap } = setup()
		await expect(
			cap.invoke(call('connect', { id: 'fastmail', accountId: 'primary' }))
		).rejects.toMatchObject({ code: 'CAPABILITY_INVALID_INPUT' })
	})

	test('rejects unknown methods', async () => {
		const { cap } = setup()
		await expect(cap.invoke(call('subscribe', {}))).rejects.toMatchObject({
			code: 'CAPABILITY_UNAVAILABLE'
		})
	})
})
