// Client-only app SDK. Installs `window.app` with a small, stable surface.
//
// Loaded as a plain script before app code (see hello/index.html). The host
// posts JSON-RPC notifications and responses over MessageChannel/postMessage;
// this SDK fans lifecycle notifications to author-registered callbacks and
// correlates request/response frames for typed APIs (`volume`, …).
// Idempotent: a second load is a no-op so apps can include it without
// worrying about double-injection.
//
// Build pipeline: this file is bundled to `dist/sdk.js` as a classic-script
// IIFE by `bun build --format=iife`. Type-only imports are stripped, so
// the wire artifact has zero runtime dependencies.

import type {
	App,
	AppAgent,
	AppCapabilities,
	AppLifecycle,
	AppRpcMethod,
	AppRpcParams,
	AppRpcResult,
	AppTool,
	AppToolRegistry,
	AppVolume
} from './protocol.js'

declare global {
	interface Window {
		readonly app: App
	}
}

type Pending = {
	resolve: (value: unknown) => void
	reject: (reason: unknown) => void
}

void (() => {
	if (typeof window === 'undefined' || (window as { app?: App }).app) return

	const API_VERSION = 1
	const onStart = new Set<() => void>()
	const onStop = new Set<() => void>()
	const pending = new Map<string, Pending>()
	const toolHandlers = new Map<string, (input: unknown) => unknown | Promise<unknown>>()
	let started = false
	let nextId = 0

	const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

	let describeCallback: (() => string | Promise<string>) | null = null

	function uint8ToBase64(u8: Uint8Array): string {
		let bin = ''
		for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i] ?? 0)
		return btoa(bin)
	}

	function base64ToUint8(b64: string): Uint8Array {
		const bin = atob(b64)
		const u8 = new Uint8Array(bin.length)
		for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
		return u8
	}

	function request<M extends AppRpcMethod>(
		method: M,
		params: AppRpcParams<M>
	): Promise<AppRpcResult<M>> {
		const id = `app-${++nextId}`
		return new Promise<AppRpcResult<M>>((resolve, reject) => {
			pending.set(id, { resolve: resolve as Pending['resolve'], reject })
			window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*')
		})
	}

	window.addEventListener('message', (event) => {
		if (event.source !== window.parent) return
		const data = event.data
		if (!isRecord(data) || data.jsonrpc !== '2.0') return

		if (data.id != null && ('result' in data || 'error' in data)) {
			const id = String(data.id)
			const p = pending.get(id)
			if (!p) return
			pending.delete(id)
			if (isRecord(data.error)) {
				const err = new Error(String(data.error.message ?? 'rpc_error')) as Error & {
					code?: number
					data?: unknown
				}
				if (typeof data.error.code === 'number') err.code = data.error.code
				if ('data' in data.error) err.data = data.error.data
				p.reject(err)
			} else {
				p.resolve(data.result)
			}
			return
		}

		// Host-to-client request: has id and method but no result/error.
		if (data.id != null && typeof data.method === 'string') {
			const id = String(data.id)
			if (data.method === 'app.agent.describe') {
				void (async () => {
					try {
						const description = describeCallback ? await describeCallback() : null
						window.parent.postMessage({ jsonrpc: '2.0', id, result: { description } }, '*')
					} catch (err) {
						const message = err instanceof Error ? err.message : 'describe_error'
						window.parent.postMessage({ jsonrpc: '2.0', id, error: { code: -32000, message } }, '*')
					}
				})()
				return
			}
			if (data.method === 'app.tool.invoke' && isRecord(data.params)) {
				const { callId, name, input } = data.params as {
					callId: string
					name: string
					input: unknown
				}
				void (async () => {
					const handler = toolHandlers.get(name)
					if (!handler) {
						window.parent.postMessage(
							{
								jsonrpc: '2.0',
								id,
								error: { code: -32020, message: 'tool_unavailable' }
							},
							'*'
						)
						return
					}
					try {
						const result = await handler(input)
						window.parent.postMessage(
							{ jsonrpc: '2.0', id, result: { callId, value: result } },
							'*'
						)
					} catch (err) {
						const message = err instanceof Error ? err.message : 'tool_handler_error'
						window.parent.postMessage({ jsonrpc: '2.0', id, error: { code: -32022, message } }, '*')
					}
				})()
				return
			}
			return
		}

		if (data.method !== 'app.lifecycle' || !isRecord(data.params)) return
		if (data.params.event === 'start' && !started) {
			started = true
			for (const cb of onStart) {
				try {
					cb()
				} catch (err) {
					console.error('app.lifecycle.onStart callback threw:', err)
				}
			}
			onStart.clear()
			return
		}
		if (data.params.event === 'stop' && started) {
			started = false
			for (const cb of onStop) {
				try {
					cb()
				} catch (err) {
					console.error('app.lifecycle.onStop callback threw:', err)
				}
			}
			onStop.clear()
			// Drop tool handlers so any in-flight or late host invocations
			// route through the unknown-tool path with `tool_unavailable`.
			toolHandlers.clear()
		}
	})

	const lifecycleImpl: AppLifecycle = {
		onStart(callback: () => void): () => void {
			if (typeof callback !== 'function') return () => {}
			if (started) {
				queueMicrotask(callback)
				return () => {}
			}
			onStart.add(callback)
			return () => {
				onStart.delete(callback)
			}
		},
		onStop(callback: () => void): () => void {
			if (typeof callback !== 'function') return () => {}
			onStop.add(callback)
			return () => {
				onStop.delete(callback)
			}
		}
	}
	const lifecycle: AppLifecycle = Object.freeze(lifecycleImpl)

	// Per-capability proxy: any property access becomes a method call that
	// fans out to the single generic `app.capability.invoke` RPC. Method
	// names aren't enumerated here — each capability's typed contract on
	// `AppCapabilityMap` decides what authors can call. Errors thrown by
	// the host broker travel back as `code: -32010` (denied) or
	// `code: -32011` (failed) with `data: { capability, method }`.
	function capabilityProxy(id: string): unknown {
		return new Proxy(
			{},
			{
				get(_target, prop) {
					if (typeof prop !== 'string') return undefined
					return async (input: unknown) => {
						const r = await request('app.capability.invoke', {
							capability: id,
							method: prop,
							input
						})
						return r.value
					}
				}
			}
		)
	}

	const capabilities = new Proxy({} as Record<string, unknown>, {
		get(target, prop) {
			if (typeof prop !== 'string') return undefined
			let cached = target[prop]
			if (!cached) {
				cached = capabilityProxy(prop)
				target[prop] = cached
			}
			return cached
		}
	}) as AppCapabilities

	const volumeImpl: AppVolume = {
		async readText(path: string): Promise<string> {
			const r = await request('app.volume.readText', { path })
			return r.text
		},
		async writeText(path: string, text: string): Promise<void> {
			await request('app.volume.writeText', { path, text })
		},
		async readFile(path: string): Promise<Uint8Array> {
			const r = await request('app.volume.readFile', { path })
			return base64ToUint8(r.bytes)
		},
		async writeFile(path: string, bytes: Uint8Array): Promise<void> {
			if (!(bytes instanceof Uint8Array)) throw new TypeError('bytes must be a Uint8Array')
			await request('app.volume.writeFile', { path, bytes: uint8ToBase64(bytes) })
		}
	}
	const volume: AppVolume = Object.freeze(volumeImpl)

	const toolsImpl: AppToolRegistry = {
		register({ name, description, schema, handler }: AppTool): () => void {
			if (typeof name !== 'string' || !name)
				throw new TypeError('tool name must be a non-empty string')
			if (typeof handler !== 'function') throw new TypeError('tool handler must be a function')
			toolHandlers.set(name, handler)
			void request('app.tool.register', { name, description, schema })
			return () => {
				toolHandlers.delete(name)
			}
		}
	}
	const tools: AppToolRegistry = Object.freeze(toolsImpl)

	const agentImpl: AppAgent = {
		async send(text: string): Promise<string> {
			if (typeof text !== 'string') throw new TypeError('text must be a string')
			const r = await request('app.agent.send', { text })
			return r.text
		},
		describe(callback: () => string | Promise<string>): void {
			describeCallback = callback
		},
		tools
	}
	const agent: AppAgent = Object.freeze(agentImpl)

	const app: App = Object.freeze({
		version: API_VERSION,
		lifecycle,
		volume,
		capabilities,
		agent
	})

	Object.defineProperty(window, 'app', {
		value: app,
		configurable: false,
		enumerable: true,
		writable: false
	})
})()
