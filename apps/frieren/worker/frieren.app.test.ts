import { describe, expect, mock, test } from 'bun:test'
import { APP_RPC_ERROR } from '@justfiles/app'
import type { CapabilityBridge } from '@justfiles/app/capabilities'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { Runtime } from './frieren.runtime'

mock.module('virtual:@justfiles/apps', () => ({
	registry: new Map([
		['demo', { manifest: { name: 'Demo', description: 'Demo app' } }],
		['other', { manifest: { name: 'Other', description: 'Other app' } }]
	])
}))
mock.module('@justfiles/app/sdk?raw', () => ({ default: '' }))

const { FrierenAppHost } = await import('./frieren.app')

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
	const capabilityCalls: unknown[] = []
	const capabilityBridge: CapabilityBridge = {
		async invoke(req) {
			capabilityCalls.push(req)
			return { ok: true }
		}
	}
	const makeRuntime = (toolList: AgentTool[]) =>
		({
			addTools(next: readonly AgentTool[]) {
				toolList.push(...next)
			},
			removeTools(next: readonly AgentTool[]) {
				for (const tool of next) {
					const index = toolList.indexOf(tool)
					if (index >= 0) toolList.splice(index, 1)
				}
			}
		}) as Runtime
	let runtime = makeRuntime(tools)
	const host = new FrierenAppHost({
		storage,
		volume: {} as never,
		websockets: () => sockets,
		runtime: () => runtime,
		capabilityBridge,
		sendAgentPrompt: async () => ''
	})
	return {
		host,
		storage,
		sockets,
		tools,
		capabilityCalls,
		swapRuntime(nextTools: AgentTool[]) {
			runtime = makeRuntime(nextTools)
		}
	}
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

	test('rebind restores proxy tools on the current runtime and keeps pending calls', async () => {
		const { host, sockets, tools, swapRuntime } = setup()
		const ws = sockets[0] as unknown as WebSocket
		await host.launch('demo')
		await host.registerClientTool(descriptor)
		const pending = (
			tools[0] as AgentTool & { execute: (id: string, input: unknown) => Promise<unknown> }
		).execute('call', {})
		const invoke = sockets[0].sent.at(-1) as { callId: string }
		const nextTools: AgentTool[] = []
		swapRuntime(nextTools)

		await host.rebind()
		await host.handleMessage(ws, {
			type: 'app_tool_result',
			callId: invoke.callId,
			result: { ok: true }
		})

		expect(nextTools.map((tool) => tool.name)).toEqual(['demo_client_pick'])
		await expect(pending).resolves.toEqual({
			content: [{ type: 'text', text: JSON.stringify({ ok: true }, null, 2) }],
			details: { ok: true }
		})
	})

	test('clear rejects pending calls, removes tools, and deletes storage', async () => {
		const { host, storage, tools } = setup()
		await host.launch('demo')
		await host.registerClientTool(descriptor)
		const pending = (
			tools[0] as AgentTool & { execute: (id: string, input: unknown) => Promise<unknown> }
		).execute('call', {})

		await host.clear()

		expect(tools).toEqual([])
		expect(host.current()).toBeUndefined()
		expect(storage.values.has('active_app')).toBe(false)
		expect(storage.values.has('active_app_client_tools:demo')).toBe(false)
		await expect(pending).rejects.toEqual({ code: -32020, message: 'tool_unavailable' })
	})

	test('clear then launch starts with clean client tools', async () => {
		const { host, storage, tools } = setup()
		await host.launch('demo')
		await host.registerClientTool(descriptor)

		await host.clear()
		await host.launch('demo')

		expect(tools).toEqual([])
		expect(storage.values.get('active_app')).toEqual({ id: 'demo' })
		expect(storage.values.has('active_app_client_tools:demo')).toBe(false)
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

	test('handleMessage claims app messages and rejects prompt/abort', async () => {
		const { host, storage, sockets } = setup()
		const ws = sockets[0] as unknown as WebSocket

		expect(await host.handleMessage(ws, { type: 'prompt' })).toBe(false)
		expect(await host.handleMessage(ws, { type: 'abort' })).toBe(false)
		expect(await host.handleMessage(ws, { type: 'app_launch', id: 'demo' })).toBe(true)
		expect(storage.values.get('active_app')).toEqual({ id: 'demo' })
		expect(await host.handleMessage(ws, { type: 'app_rpc' })).toBe(true)
		expect(await host.handleMessage(ws, { type: 'app_tool_result' })).toBe(true)
		expect(await host.handleMessage(ws, { type: 'app_iframe_reload' })).toBe(true)
		expect(await host.handleMessage(ws, { type: 'app_close' })).toBe(true)
		expect(storage.values.has('active_app')).toBe(false)
	})

	test('app.tool.register adds a runtime tool and persists idempotently', async () => {
		const { host, storage, sockets, tools } = setup()
		const ws = sockets[0] as unknown as WebSocket
		await host.launch('demo')
		const frame = {
			id: '1',
			method: 'app.tool.register',
			params: descriptor
		}

		await host.handleMessage(ws, { type: 'app_rpc', frame })
		await host.handleMessage(ws, { type: 'app_rpc', frame: { ...frame, id: '2' } })

		expect(tools.map((tool) => tool.name)).toEqual(['demo_client_pick'])
		expect(storage.values.get('active_app_client_tools:demo')).toEqual([descriptor])
		expect(sockets[0].sent.at(-1)).toEqual({
			type: 'app_rpc',
			frame: { jsonrpc: '2.0', id: '2', result: null }
		})
	})

	test('client tool round-trip resolves and rejects on app_tool_result', async () => {
		const { host, sockets, tools } = setup()
		const ws = sockets[0] as unknown as WebSocket
		await host.launch('demo')
		await host.registerClientTool(descriptor)

		const ok = (
			tools[0] as AgentTool & { execute: (id: string, input: unknown) => Promise<unknown> }
		).execute('call', { value: 1 })
		const invoke = sockets[0].sent.at(-1) as { callId: string }
		await host.handleMessage(ws, {
			type: 'app_tool_result',
			callId: invoke.callId,
			result: { picked: 1 }
		})
		await expect(ok).resolves.toEqual({
			content: [{ type: 'text', text: JSON.stringify({ picked: 1 }, null, 2) }],
			details: { picked: 1 }
		})

		const bad = (
			tools[0] as AgentTool & { execute: (id: string, input: unknown) => Promise<unknown> }
		).execute('call', { value: 2 })
		const failed = sockets[0].sent.at(-1) as { callId: string }
		await host.handleMessage(ws, {
			type: 'app_tool_result',
			callId: failed.callId,
			error: { code: -1, message: 'nope' }
		})
		await expect(bad).rejects.toEqual({ code: -1, message: 'nope' })
	})

	test('iframe reload rejects pending calls, removes tools, and clears storage', async () => {
		const { host, storage, sockets, tools } = setup()
		const ws = sockets[0] as unknown as WebSocket
		await host.launch('demo')
		await host.registerClientTool(descriptor)
		const pending = (
			tools[0] as AgentTool & { execute: (id: string, input: unknown) => Promise<unknown> }
		).execute('call', {})

		await host.handleMessage(ws, { type: 'app_iframe_reload' })

		expect(tools).toEqual([])
		expect(storage.values.has('active_app_client_tools:demo')).toBe(false)
		await expect(pending).rejects.toEqual({ code: -32020, message: 'tool_unavailable' })
	})

	test('app_rpc with no active app returns noActiveApp', async () => {
		const { host, sockets } = setup()
		const ws = sockets[0] as unknown as WebSocket

		await host.handleMessage(ws, {
			type: 'app_rpc',
			frame: { id: '1', method: 'app.tool.register', params: descriptor }
		})

		expect(sockets[0].sent).toEqual([
			{
				type: 'app_rpc',
				frame: { jsonrpc: '2.0', id: '1', error: APP_RPC_ERROR.noActiveApp }
			}
		])
	})

	test('callActive returns null when no active app', async () => {
		const { host } = setup()
		await expect(host.callActive('app.agent.describe', {})).resolves.toBeNull()
	})

	test('callActive returns null when active but no connected websocket', async () => {
		const storage = new StorageStub()
		const tools: AgentTool[] = []
		const makeRuntime = () =>
			({
				addTools(next: readonly AgentTool[]) {
					tools.push(...next)
				},
				removeTools(next: readonly AgentTool[]) {
					for (const tool of next) {
						const index = tools.indexOf(tool)
						if (index >= 0) tools.splice(index, 1)
					}
				}
			}) as Runtime
		const host = new FrierenAppHost({
			storage,
			volume: {} as never,
			websockets: () => [],
			runtime: () => makeRuntime(),
			capabilityBridge: {
				async invoke() {
					return { ok: true }
				}
			},
			sendAgentPrompt: async () => ''
		})
		await host.launch('demo')
		await expect(host.callActive('app.agent.describe', {})).resolves.toBeNull()
	})

	test('callActive resolves with the iframe-supplied frame on app_host_reply', async () => {
		const { host, sockets } = setup()
		const ws = sockets[0] as unknown as WebSocket
		await host.launch('demo')

		const pending = host.callActive('app.agent.describe', {})
		const sent = sockets[0].sent.at(-1) as {
			type: string
			frame: { id: string; method: string }
		}
		expect(sent.type).toBe('app_host_call')
		expect(sent.frame.method).toBe('app.agent.describe')

		await host.handleMessage(ws, {
			type: 'app_host_reply',
			frame: { id: sent.frame.id, result: { description: 'hello' } }
		})

		await expect(pending).resolves.toEqual({ description: 'hello' })
	})

	test('callActive returns null on timeout', async () => {
		const { host } = setup()
		await host.launch('demo')

		const originalSetTimeout = globalThis.setTimeout
		globalThis.setTimeout = ((fn: () => void) => {
			Promise.resolve().then(() => fn())
			return 0 as unknown as ReturnType<typeof originalSetTimeout>
		}) as typeof globalThis.setTimeout
		try {
			await expect(host.callActive('app.agent.describe', {})).resolves.toBeNull()
		} finally {
			globalThis.setTimeout = originalSetTimeout
		}
	})

	test('callActive forwards error frames as null and logs', async () => {
		const { host, sockets } = setup()
		const ws = sockets[0] as unknown as WebSocket
		await host.launch('demo')

		const pending = host.callActive('app.agent.describe', {})
		const sent = sockets[0].sent.at(-1) as { frame: { id: string } }
		await host.handleMessage(ws, {
			type: 'app_host_reply',
			frame: { id: sent.frame.id, error: { code: -32021, message: 'host_call_timeout' } }
		})

		await expect(pending).resolves.toBeNull()
	})

	test('capability RPC uses the constructor bridge', async () => {
		const { host, sockets, capabilityCalls } = setup()
		const ws = sockets[0] as unknown as WebSocket
		await host.launch('demo')

		await host.handleMessage(ws, {
			type: 'app_rpc',
			frame: {
				id: '1',
				method: 'app.capability.invoke',
				params: { capability: 'email', method: 'listUnread', input: { limit: 1 } }
			}
		})

		expect(capabilityCalls).toEqual([
			{ capability: 'email', method: 'listUnread', input: { limit: 1 } }
		])
		expect(sockets[0].sent.at(-1)).toEqual({
			type: 'app_rpc',
			frame: { jsonrpc: '2.0', id: '1', result: { value: { ok: true } } }
		})
	})
})
