// Plain-JS session driver for an ESM app. Lives outside React so the
// load / register / dispose sequence is deterministic and immune to
// component re-renders. `EsmAppFrame` is now just a shell around a
// container div and a Home button; everything that talks to the
// worker, owns the tool registry, or holds the app handle is here.

import {
	type Agent,
	type AppHandle,
	type AppRelay,
	type AppRpcRequest,
	type Capabilities,
	createHost,
	createToolRegistry,
	loadApp,
	loadManifest,
	type ToolInvokeHandler
} from '@justfiles/app'
import { createFsVolume } from './fs'

// Capability brokers run in the worker; routing direct typed calls from
// the browser to those brokers is its own slice. Until that lands, expose
// a stub that throws so any accidental call surfaces clearly instead of
// silently resolving.
function stubCapabilities(): Capabilities {
	const reject = (capability: string, method: string) => () =>
		Promise.reject(new Error(`capability ${capability}.${method} not wired`))
	return {
		email: {
			listUnread: reject('email', 'listUnread'),
			readDetail: reject('email', 'readDetail'),
			markRead: reject('email', 'markRead')
		},
		calendar: {
			listToday: reject('calendar', 'listToday')
		}
	}
}

let rpcCounter = 0
const nextRpcId = () => `esm-${++rpcCounter}`

export interface RunEsmAppOptions {
	el: HTMLElement
	manifestUrl: string
	baseUrl: string
	getToken: () => Promise<string | null>
	relay: AppRelay
	setAppDescribe: (fn: (() => Promise<string | null>) | null) => void
	signal?: AbortSignal
}

export interface EsmAppSession {
	dispose(): Promise<void>
}

export async function runEsmApp(opts: RunEsmAppOptions): Promise<EsmAppSession> {
	const { el, manifestUrl, baseUrl, getToken, relay, setAppDescribe, signal } = opts

	let disposed = false
	let handle: AppHandle | undefined
	let registerError: unknown
	const pendingRegistrations = new Set<Promise<void>>()
	const throwIfAborted = () => {
		if (signal?.aborted) throw new Error('app session aborted')
	}

	const absoluteManifestUrl = new URL(manifestUrl, window.location.href).toString()
	const absoluteBaseUrl = new URL(baseUrl, window.location.href).toString()
	const manifest = await loadManifest({ url: absoluteManifestUrl })
	throwIfAborted()

	const backend = await createFsVolume(getToken)
	throwIfAborted()

	const waitForRegistrations = async () => {
		await Promise.all([...pendingRegistrations])
		if (registerError) throw registerError
	}

	const sendAgentPrompt = async (text: string): Promise<string> => {
		await waitForRegistrations()
		const frame: AppRpcRequest = {
			jsonrpc: '2.0',
			id: nextRpcId(),
			method: 'app.agent.send',
			params: { text }
		}
		const reply = await relay.sendRpc(frame)
		if (reply.error) throw new Error(reply.error.message)
		const result = reply.result as { text: string } | undefined
		return result?.text ?? ''
	}

	const registerWithWorker = async (tool: {
		name: string
		description: string
		schema: unknown
	}) => {
		const frame: AppRpcRequest = {
			jsonrpc: '2.0',
			id: nextRpcId(),
			method: 'app.tool.register',
			params: {
				name: tool.name,
				description: tool.description,
				schema: tool.schema as Record<string, unknown>
			}
		}
		const reply = await relay.sendRpc(frame)
		if (reply.error) throw new Error(reply.error.message)
	}

	const tools = createToolRegistry({
		onRegister: (tool) => {
			const pending = registerWithWorker(tool)
				.catch((err) => {
					registerError = err
					console.error('failed to register tool with worker:', err)
				})
				.finally(() => pendingRegistrations.delete(pending))
			pendingRegistrations.add(pending)
		}
	})

	const toolInvokeHandler: ToolInvokeHandler = (callId, name, input) => {
		void (async () => {
			try {
				const value = await tools.invoke(name, input)
				relay.sendToolResult(callId, value)
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e)
				relay.sendToolResult(callId, undefined, { code: -32022, message })
			}
		})()
	}
	relay.onToolInvoke(toolInvokeHandler)

	const agent: Agent = { send: sendAgentPrompt, tools: tools.registry }
	const host = createHost({
		appId: manifest.id,
		volume: backend,
		capabilities: stubCapabilities(),
		agent
	})

	throwIfAborted()
	handle = await loadApp({
		manifest,
		baseUrl: absoluteBaseUrl,
		el,
		host
	})

	if (disposed || signal?.aborted) {
		// dispose() was called before mount finished; tear down what we built.
		await handle.unmount()
		tools.dispose()
		relay.onToolInvoke(null)
		return { async dispose() {} }
	}

	const loaded = handle
	setAppDescribe(() => loaded.describe())

	return {
		async dispose() {
			if (disposed) return
			disposed = true
			setAppDescribe(null)
			relay.onToolInvoke(null)
			await handle?.unmount()
			tools.dispose()
		}
	}
}
