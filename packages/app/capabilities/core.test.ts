import { volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { expect, test, vi } from 'vitest'
import { defineCapability, implementTool } from './core.ts'

interface FakeMethods {
	ping(input: { a: number }): Promise<{ pong: number }>
	silent(input: { b: string }): Promise<void>
}

const fake = defineCapability<'fake', FakeMethods>('fake', {
	ping: { description: 'Ping the thing.', input: { type: 'object' } }
	// `silent` carries no metadata → no tool derived.
})

test('the factory carries the contract runtime side without being called', () => {
	expect(fake.id).toBe('fake')
	expect(fake.methods?.ping?.description).toBe('Ping the thing.')
	// Calling it still yields the app-facing handle.
	expect(fake({ scopes: [] })).toEqual({ id: 'fake', scopes: [] })
})

test('implementTool derives a passthrough tool per metadata-carrying method', async () => {
	const set = implementTool(fake)
	expect(set.capability).toBe('fake')
	expect(set.tools.map((t) => t.name)).toEqual(['fake_ping'])
	const [tool] = set.tools
	expect(tool?.description).toBe('Ping the thing.')
	expect(tool?.parameters).toEqual({ type: 'object' })
	const invoke = vi.fn(async () => ({ pong: 2 }))
	const result = await tool?.execute(invoke, { a: 1 }, { volume: volume(memStore()) })
	expect(invoke).toHaveBeenCalledWith('ping', { a: 1 })
	expect(result).toEqual({ pong: 2 })
})

test('overrides replace name, description, and execute', async () => {
	const set = implementTool(fake, {
		ping: {
			name: 'ping',
			description: 'For the model.',
			execute: async (_invoke, params) => ({ content: `sent ${params.a}` })
		}
	})
	const [tool] = set.tools
	expect(tool?.name).toBe('ping')
	expect(tool?.description).toBe('For the model.')
	const result = await tool?.execute(vi.fn(), { a: 3 }, { volume: volume(memStore()) })
	expect(result).toEqual({ content: 'sent 3' })
})
