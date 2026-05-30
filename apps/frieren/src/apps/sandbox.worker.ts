import type { GetSandbox, Sandbox } from '@justfiles/app'
import {
	capabilityError,
	fromWireError,
	toWireError,
	type WireError
} from '../../shared/capability-error.ts'

// Browser-side GetSandbox. It runs the same volume-backed app.js bytes as the
// server kernel, but in a module Web Worker and bridges host callbacks over
// postMessage.

type CapabilityInvocation = {
	capability: string
	method: string
	input: unknown
	scopes: readonly string[]
	actor?: string
}

type BrowserSandboxOptions = {
	capabilities?: (req: CapabilityInvocation & { appId: string }) => Promise<unknown>
}

type WorkerMessage =
	| { type: 'result'; id: string; result: unknown }
	| { type: 'error'; id: string; error: WireError }
	| { type: 'setState'; id: string; callId: string; state: unknown }
	| { type: 'capability'; id: string; callId: string; req: CapabilityInvocation }

type HostContext = Parameters<Sandbox['run']>[1]

type Pending = {
	resolve: (value: unknown) => void
	reject: (error: Error) => void
	ctx?: HostContext
}

// One Web Worker per distinct app bundle (content hash), shared across every
// window of that app — mirroring the server's content-addressed isolate-per-app
// model. `appWorkers` maps an app id to its current bundle key so the host can
// `terminateAppWorker` when an app's last window closes (apps are 1:1 with
// their code, so an id resolves to exactly one worker).
const workers = new Map<string, Promise<WorkerClient>>()
const appWorkers = new Map<string, string>()

export function browserSandbox(options: BrowserSandboxOptions = {}): GetSandbox {
	return async ({ appId, code }) => {
		const key = await cacheKey(code)
		const worker = await workerFor(key, code)
		appWorkers.set(appId, key)
		const capabilities = options.capabilities
		return {
			run: (action, ctx) =>
				worker.request(
					'dispatch',
					{ action, state: ctx.state },
					{
						...ctx,
						capabilityInvoke: capabilities ? (req) => capabilities({ ...req, appId }) : undefined
					}
				) as Promise<Awaited<ReturnType<Sandbox['run']>>>,
			actions: () =>
				worker.request('actions', {}) as Promise<
					Awaited<ReturnType<NonNullable<Sandbox['actions']>>>
				>
		}
	}
}

async function workerFor(key: string, code: string): Promise<WorkerClient> {
	let worker = workers.get(key)
	if (!worker) {
		worker = Promise.resolve(new WorkerClient(code, () => workers.delete(key)))
		workers.set(key, worker)
	}
	return worker
}

// Terminate the worker backing `appId` (called by the host when the app's last
// window closes) so its thread and bundle blob are reclaimed.
export function terminateAppWorker(appId: string): void {
	const key = appWorkers.get(appId)
	if (!key) return
	appWorkers.delete(appId)
	const worker = workers.get(key)
	workers.delete(key)
	void worker?.then((client) => client.terminate()).catch(() => {})
}

async function cacheKey(code: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

class WorkerClient {
	private readonly worker: Worker
	private readonly appUrl: string
	private nextId = 0
	private readonly pending = new Map<string, Pending>()

	// `onDead` evicts this client from the worker cache so a crashed worker is
	// never handed back out; the next dispatch rebuilds a fresh one.
	constructor(code: string, onDead: () => void) {
		this.appUrl = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }))
		const workerUrl = URL.createObjectURL(
			new Blob([workerSource(this.appUrl)], { type: 'application/javascript' })
		)
		this.worker = new Worker(workerUrl, { type: 'module' })
		URL.revokeObjectURL(workerUrl)
		this.worker.onmessage = (event: MessageEvent<WorkerMessage>) => this.onMessage(event.data)
		this.worker.onerror = (event) => {
			onDead()
			const error = new Error(event.message || 'sandbox worker error')
			for (const [, pending] of this.pending) pending.reject(error)
			this.pending.clear()
			this.terminate()
		}
	}

	terminate(): void {
		this.worker.terminate()
		URL.revokeObjectURL(this.appUrl)
	}

	request(type: 'dispatch' | 'actions', payload: object, ctx?: HostContext): Promise<unknown> {
		const id = String(this.nextId++)
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject, ctx })
			this.worker.postMessage({ type, id, ...payload })
		})
	}

	private onMessage(message: WorkerMessage): void {
		if (message.type === 'result' || message.type === 'error') {
			const pending = this.pending.get(message.id)
			if (!pending) return
			this.pending.delete(message.id)
			if (message.type === 'error') pending.reject(fromWireError(message.error))
			else pending.resolve(message.result)
			return
		}

		const pending = this.pending.get(message.id)
		const reply = (type: 'hostResult' | 'hostError', value: unknown) => {
			this.worker.postMessage({
				type,
				callId: message.callId,
				...(type === 'hostResult' ? { result: value } : { error: toWireError(value) })
			})
		}
		void (async () => {
			try {
				if (message.type === 'setState') await pending?.ctx?.setState(message.state)
				else if (message.type === 'capability') {
					if (!pending?.ctx?.capabilityInvoke) throw capabilityError('CAPABILITY_UNAVAILABLE')
					reply('hostResult', await pending.ctx.capabilityInvoke(message.req))
					return
				}
				reply('hostResult', undefined)
			} catch (error) {
				reply('hostError', error)
			}
		})()
	}
}

function workerSource(appUrl: string): string {
	return `import { app } from ${JSON.stringify(appUrl)}
let nextCallId = 0
const pending = new Map()
function errorToWire(error) {
	return error instanceof Error
		? { message: error.message, code: error.code, capability: error.capability, method: error.method }
		: { message: String(error) }
}
function errorFromWire(error) {
	return Object.assign(new Error(error.message), {
		code: error.code,
		capability: error.capability,
		method: error.method
	})
}
function hostCall(id, type, payload) {
	const callId = String(nextCallId++)
	return new Promise((resolve, reject) => {
		pending.set(callId, { resolve, reject })
		self.postMessage({ type, id, callId, ...payload })
	})
}
self.onmessage = async (event) => {
	const msg = event.data
	if (msg.type === 'hostResult' || msg.type === 'hostError') {
		const p = pending.get(msg.callId)
		if (!p) return
		pending.delete(msg.callId)
		if (msg.type === 'hostError') p.reject(errorFromWire(msg.error))
		else p.resolve(msg.result)
		return
	}
	try {
		if (msg.type === 'actions') {
			self.postMessage({ type: 'result', id: msg.id, result: app.actions ?? {} })
			return
		}
		const result = await app.dispatch(msg.action, {
			state: msg.state,
			setState: (state) => hostCall(msg.id, 'setState', { state }),
			capabilityInvoke: (req) => hostCall(msg.id, 'capability', { req })
		})
		self.postMessage({ type: 'result', id: msg.id, result })
	} catch (error) {
		self.postMessage({ type: 'error', id: msg.id, error: errorToWire(error) })
	}
}
`
}
