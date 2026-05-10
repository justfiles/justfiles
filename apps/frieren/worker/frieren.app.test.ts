import { describe, expect, mock, test } from 'bun:test'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { Runtime } from './frieren.runtime'

mock.module('virtual:@justfiles/apps', () => ({
	registry: new Map([
		['demo', { manifest: { name: 'Demo', description: 'Demo app' } }],
		['other', { manifest: { name: 'Other', description: 'Other app' } }]
	])
}))
mock.module('@justfiles/app/sdk?raw', () => ({ default: '' }))

const { AppHost } = await import('./frieren.app')

class StorageStub {
	readonly values = new Map<string, unknown>()

	async get<T>(key: string): Promise<T | undefined> {
		return this.values.get(key) as T | undefined
	}

	async put<T>(key: string, value: T): Promise<void> {
		this.values.set(key, value)
	}

	async delete(key: string): Promise<boolean> {
		return this.values.delete(key)
	}
}

class SocketStub {
	readonly sent: unknown[] = []

	send(value: string): void {
		this.sent.push(JSON.parse(value))
	}
}

function setup() {
	const storage = new StorageStub()
	const sockets = [new SocketStub()]
	const tools: AgentTool[] = []
	const runtime = {
		addTools(next: readonly AgentTool[]) {
			tools.push(...next)
		},
		removeTools(next: readonly AgentTool[]) {
			for (const tool of next) {
				const index = tools.indexOf(tool)
				if (index >= 0) tools.splice(index, 1)
			}
		}
	} as Runtime
	const host = new AppHost({
		storage,
		volume: {} as never,
		websockets: () => sockets,
		runtime: () => runtime,
		sendAgentPrompt: async () => ''
	})
	return { host, storage, sockets, tools }
}

const descriptor = {
	name: 'pick',
	description: 'Pick a value',
	schema: { type: 'object', properties: {} }
}

describe('AppHost', () => {
	test('launch persists active app and broadcasts app_open', async () => {
		const { host, storage, sockets } = setup()

		await host.launch('demo')

		expect(storage.values.get('active_app')).toEqual({ id: 'demo' })
		expect(sockets[0].sent).toEqual([{ type: 'app_open', id: 'demo', ui: { url: '/apps/demo/' } }])
	})

	test('launch while active closes the previous app', async () => {
		const { host, storage, sockets } = setup()
		await host.launch('demo')
		await host.registerClientTool(descriptor)

		await host.launch('other')

		expect(storage.values.get('active_app')).toEqual({ id: 'other' })
		expect(storage.values.has('active_app_client_tools:demo')).toBe(false)
		expect(sockets[0].sent).toEqual([
			{ type: 'app_open', id: 'demo', ui: { url: '/apps/demo/' } },
			{ type: 'app_close' },
			{ type: 'app_open', id: 'other', ui: { url: '/apps/other/' } }
		])
	})

	test('hydrate restores active app and is idempotent', async () => {
		const { host, storage, tools } = setup()
		storage.values.set('active_app', { id: 'demo' })
		storage.values.set('active_app_client_tools:demo', [descriptor])

		await host.hydrate()
		await host.hydrate()

		expect(host.current()).toEqual({ id: 'demo' })
		expect(tools.map((tool) => tool.name)).toEqual(['demo_client_pick'])
	})

	test('close removes tools, deletes storage, and broadcasts app_close', async () => {
		const { host, storage, sockets, tools } = setup()
		await host.launch('demo')
		await host.registerClientTool(descriptor)

		await host.close()

		expect(tools).toEqual([])
		expect(storage.values.has('active_app')).toBe(false)
		expect(storage.values.has('active_app_client_tools:demo')).toBe(false)
		expect(sockets[0].sent.at(-1)).toEqual({ type: 'app_close' })
	})

	test('slash commands route app commands only', async () => {
		const { host, storage } = setup()

		expect(await host.handlePromptCommand('hello')).toBe(false)
		expect(await host.handlePromptCommand('/missing')).toBe(false)
		expect(await host.handlePromptCommand('/demo')).toBe(true)
		expect(storage.values.get('active_app')).toEqual({ id: 'demo' })
		expect(await host.handlePromptCommand('/close')).toBe(true)
		expect(storage.values.has('active_app')).toBe(false)
	})

	test('handleMessage handles launch and close only', async () => {
		const { host, storage } = setup()

		expect(await host.handleMessage({} as WebSocket, { type: 'prompt' })).toBe(false)
		expect(await host.handleMessage({} as WebSocket, { type: 'app_rpc' })).toBe(false)
		expect(await host.handleMessage({} as WebSocket, { type: 'app_launch', id: 'demo' })).toBe(true)
		expect(storage.values.get('active_app')).toEqual({ id: 'demo' })
		expect(await host.handleMessage({} as WebSocket, { type: 'app_close' })).toBe(true)
		expect(storage.values.has('active_app')).toBe(false)
	})
})
