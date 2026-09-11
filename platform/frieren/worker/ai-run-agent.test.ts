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

function model(): AgentBackend {
	let step = 0
	return {
		model: { id: 'script' } as Model<Api>,
		revision: 'script',
		completeFn: vi.fn(),
		streamFn: () => {
			const content: AssistantMessage['content'] =
				step++ === 0
					? [
							{
								type: 'toolCall',
								id: 'read',
								name: 'fetch',
								arguments: { url: 'https://example.com' }
							}
						]
					: step === 2
						? [
								{
									type: 'toolCall',
									id: 'write',
									name: 'bash',
									arguments: { command: 'echo report > report.md' }
								}
							]
						: [{ type: 'text', text: 'finished' }]
			const message: AssistantMessage = {
				role: 'assistant',
				content,
				stopReason: step <= 2 ? 'toolUse' : 'stop',
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

async function setup(fetch: typeof globalThis.fetch) {
	const host = volume(memStore())
	const calls: CapabilityCall[] = []
	const keepAlive = vi.fn()
	const cap = aiCapability({
		volume: host,
		generate: async () => '',
		agent: { backend: async () => model(), fetch, keepAlive }
	})
	const served = capabilityRegistry({ ai: cap })
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
	const k = kernel({
		fs: volume(memStore()),
		sandbox: async () => sandbox,
		clock: {},
		capabilities: proxy.caps
	})
	const appId = await k.install(appBundleFromMemory({ id: 'test.agent', name: 'Agent', app: code }))
	return {
		k,
		appId,
		host,
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
	prompt: 'write a report',
	workspace: { capability: 'files', path: '/report' }
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
	const { k, appId, host, calls, keepAlive } = testHost
	try {
		const work = k.dispatch(appId, { type, params, actor: 'agent' })
		await started.promise
		expect(await k.dispatch(appId, { type: 'tick', params: {} })).toEqual({ ticks: 1, result: '' })
		expect(await k.state(appId)).toEqual({ ticks: 1, result: '' })
		expect(calls[0]).toMatchObject({
			appId,
			scopes: ['agent'],
			workspace: { capability: 'files', scopes: ['app'] }
		})
		expect(keepAlive).toHaveBeenCalledTimes(1)
		release.resolve()
		const result = await work
		expect(result).toEqual(
			type === 'work' ? { text: 'finished' } : { ticks: 1, result: 'finished' }
		)
		expect(new TextDecoder().decode(await host.readFile('/data/test.agent/report/report.md'))).toBe(
			'report\n'
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
		expect(await testHost.host.exists('/data/test.agent/report/report.md')).toBe(false)
	} finally {
		await testHost.close()
	}
})

test('the executing bundle must declare the selected volume, even if the serving host has it', async () => {
	const testHost = await setup(vi.fn())
	try {
		await expect(
			testHost.k.dispatch(testHost.appId, {
				type: 'work',
				params: { ...params, workspace: { capability: 'undeclared', path: '/' } }
			})
		).rejects.toThrow('CAPABILITY_DENIED')
		expect(testHost.calls).toEqual([])
	} finally {
		await testHost.close()
	}
})
