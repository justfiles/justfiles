import { URL as NodeURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model
} from '@earendil-works/pi-ai'
import type { AgentBackend } from '@justfiles/agent'
import { aiCapability } from '@justfiles/agent'
import { appBundleFromMemory } from '@justfiles/app'
import {
	type CapabilityCall,
	capabilityRegistry,
	proxyCapabilitiesRpc,
	serveCapabilitiesRpc
} from '@justfiles/app/capabilities'
import { volumeCapability } from '@justfiles/app/capabilities/volume/host'
import { kernel } from '@justfiles/app/runtime'
import { sandboxClient, sandboxWorkerSource } from '@justfiles/app/sandbox'
import { volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { buildSync } from 'esbuild'
import { expect, test, vi } from 'vitest'
import { transportPair } from '../../../packages/app/capabilities/rpc.testpair.ts'
import source from '../../../packages/app/test-bundle/ai-run-agent.ts?raw'

const deferred = () => {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}
const dataUrl = (source: string) =>
	`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const code = buildSync({
	stdin: {
		contents: source,
		loader: 'ts',
		resolveDir: new URL('../../../packages/app/test-bundle', import.meta.url).pathname
	},
	bundle: true,
	write: false,
	format: 'esm'
}).outputFiles[0].text

const steps: Array<{ name: string; arguments: Record<string, unknown> }> = [
	{ name: 'fetch', arguments: { url: 'https://example.com' } },
	{
		name: 'capability',
		arguments: { capability: 'examples', method: 'readFile', args: ['/template.md'] }
	},
	{
		name: 'capability',
		arguments: {
			capability: 'files',
			method: 'writeFile',
			args: ['/report/report.md', { $bytes: 'report\n' }]
		}
	},
	{
		name: 'capability',
		arguments: { capability: 'inbox', method: 'listUnread', args: [{ limit: 2 }] }
	}
]
function model(actions: typeof steps): AgentBackend {
	let step = 0
	return {
		model: { id: 'script' } as Model<Api>,
		revision: 'script',
		completeFn: vi.fn(),
		streamFn: () => {
			const action = actions[step++]
			const content: AssistantMessage['content'] = action
				? [{ type: 'toolCall', id: String(step), ...action }]
				: [{ type: 'text', text: 'finished' }]

			const message: AssistantMessage = {
				role: 'assistant',
				content,
				stopReason: action ? 'toolUse' : 'stop',
				api: 'script',
				provider: 'script',
				model: 'script',
				timestamp: Date.now(),
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
				}
			}
			const stream = createAssistantMessageEventStream()
			stream.push({ type: 'done', reason: 'stop', message })
			stream.end(message)
			return stream
		}
	}
}

async function setup(fetch: typeof globalThis.fetch, actions = steps) {
	const host = volume(memStore())
	const calls: CapabilityCall[] = []
	const keepAlive = vi.fn()
	const cap = aiCapability({
		volume: host,
		generate: async () => '',
		agent: { backend: async () => model(actions), fetch, keepAlive }
	})
	const email = vi.fn(async () => [{ subject: 'hello' }])
	const served = capabilityRegistry({ ai: cap, email: { invoke: email, subscribe: vi.fn() } })
	const [client, server] = transportPair()
	serveCapabilitiesRpc(server, {
		...served,
		invoke: async (call) => {
			calls.push(call)
			return served.invoke(call)
		}
	})
	const proxy = proxyCapabilitiesRpc(client)
	const worker = new Worker(new NodeURL(dataUrl(sandboxWorkerSource(dataUrl(code), 'node'))))
	const { sandbox, fail } = sandboxClient({
		post: (message) => worker.postMessage(message),
		onMessage: (handler) => worker.on('message', handler)
	})
	worker.on('error', fail)
	const local = volume(memStore())
	await local.mkdir('/examples')
	await local.writeFile('/examples/template.md', new TextEncoder().encode('template'))
	const files = volumeCapability(local)
	const fileCalls = vi.fn(files.invoke)
	const k = kernel({
		fs: local,
		sandbox: async () => sandbox,
		clock: {},
		capabilities: capabilityRegistry(
			{ volume: { ...files, invoke: fileCalls } },
			{ fallback: proxy.caps }
		)
	})
	const appId = await k.install(appBundleFromMemory({ id: 'test.agent', name: 'Agent', app: code }))
	return {
		k,
		appId,
		host,
		local,
		email,
		fileCalls,
		calls,
		cap,
		keepAlive,
		close: async () => {
			k.dispose()
			proxy.dispose()
			await worker.terminate()
		}
	}
}

const params = {
	requestId: 'one',
	prompt: 'write in /report, following other workspaces as examples'
}

test.each([
	'work',
	'command'
])('awaited %s crosses the worker and capability RPC while reducer actions remain responsive', async (type) => {
	const started = deferred()
	const release = deferred()
	const testHost = await setup(async () => {
		started.resolve()
		await release.promise
		return new Response('research')
	})
	const { k, appId, host, local, email, fileCalls, calls, keepAlive } = testHost
	try {
		const work = k.dispatch(appId, { type, params, actor: 'agent' })
		await started.promise
		expect(await k.dispatch(appId, { type: 'tick', params: {} })).toEqual({ ticks: 1, result: '' })
		expect(await k.state(appId)).toEqual({ ticks: 1, result: '' })
		expect(calls[0]).toMatchObject({
			appId,
			scopes: ['agent'],
			app: {
				bindings: {
					files: { id: 'volume', scopes: ['app'] },
					examples: { id: 'volume', scopes: ['/examples'] },
					inbox: { id: 'email', scopes: ['read'] }
				}
			}
		})
		expect(keepAlive).toHaveBeenCalledTimes(1)
		release.resolve()
		const result = await work
		expect(result).toEqual(
			type === 'work' ? { text: 'finished' } : { ticks: 1, result: 'finished' }
		)
		expect(
			new TextDecoder().decode(await local.readFile('/data/test.agent/report/report.md'))
		).toBe('report\n')
		expect(await host.exists('/data/test.agent/report/report.md')).toBe(false)
		expect(fileCalls).toHaveBeenCalledWith(
			expect.objectContaining({
				appId,
				capability: 'volume',
				method: 'readFile',
				scopes: ['/examples'],
				args: ['/template.md']
			})
		)
		expect(email).toHaveBeenCalledWith(
			expect.objectContaining({
				appId,
				capability: 'email',
				scopes: ['read'],
				method: 'listUnread',
				args: [{ limit: 2 }]
			})
		)
	} finally {
		release.resolve()
		await testHost.close()
	}
})

test('Stop runs as a second procedure across RPC while the original procedure is awaiting a tool', async () => {
	const started = deferred()
	const testHost = await setup(
		async (_, init) =>
			new Promise((_, reject) => {
				started.resolve()
				init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
			})
	)
	try {
		const work = testHost.k.dispatch(testHost.appId, { type: 'work', params })
		await started.promise
		expect(
			await testHost.k.dispatch(testHost.appId, { type: 'stop', params: { requestId: 'one' } })
		).toBe(true)
		expect(await work).toEqual({ cancelled: true })
		expect(await testHost.local.exists('/data/test.agent/report/report.md')).toBe(false)
	} finally {
		await testHost.close()
	}
})

test('inherited calls cannot name an undeclared capability or supply broader scopes', async () => {
	const testHost = await setup(vi.fn(), [
		{
			name: 'capability',
			arguments: {
				capability: 'volume',
				method: 'writeFile',
				args: ['/escape', { $bytes: 'secret' }]
			}
		},
		{
			name: 'capability',
			arguments: {
				capability: '__proto__',
				method: 'writeFile',
				args: ['/escape', { $bytes: 'secret' }]
			}
		},
		{
			name: 'capability',
			arguments: {
				capability: 'files',
				method: 'writeFile',
				args: ['/own', { $bytes: 'allowed' }, { scopes: ['system'] }]
			}
		}
	])
	try {
		await testHost.k.dispatch(testHost.appId, { type: 'work', params })
		expect(testHost.fileCalls).toHaveBeenCalledTimes(1)
		expect(testHost.fileCalls).toHaveBeenCalledWith(expect.objectContaining({ scopes: ['app'] }))
		expect(await testHost.local.exists('/escape')).toBe(false)
		expect(await testHost.local.exists('/own')).toBe(false)
		expect(await testHost.local.exists('/data/test.agent/own')).toBe(true)
	} finally {
		await testHost.close()
	}
})
