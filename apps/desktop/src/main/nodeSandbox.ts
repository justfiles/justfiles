import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { fromWire, toWire, type WireError } from '@justfiles/app/capabilities'
import type { GetSandbox, Message, RawAppHandle, Sandbox } from '@justfiles/app/runtime'

type WorkerMessage =
	| { type: 'result'; id: string; result: unknown }
	| { type: 'error'; id: string; error: WireError }
	| { type: 'dispatch'; id: string; callId: string; message: Message }
	| { type: 'settled'; id: string; callId: string; seq: number; opts?: { timeout?: number } }
	| {
			type: 'invoke'
			id: string
			callId: string
			capability: string
			method: string
			args: readonly unknown[]
	  }

type Pending = {
	resolve: (value: unknown) => void
	reject: (error: Error) => void
	handle?: RawAppHandle
}

const workers = new Map<string, Promise<WorkerClient>>()

export function nodeSandbox(): GetSandbox {
	return async ({ code }) => {
		const worker = await workerFor(cacheKey(code), code)
		return {
			initialState: () => worker.request('initialState', {}),
			run: (action, ctx) =>
				worker.request('dispatch', { action, state: ctx.state }) as Promise<
					Awaited<ReturnType<Sandbox['run']>>
				>,
			actions: () =>
				worker.request('actions', {}) as Promise<
					Awaited<ReturnType<NonNullable<Sandbox['actions']>>>
				>,
			capabilities: () =>
				worker.request('capabilities', {}) as Promise<
					Awaited<ReturnType<NonNullable<Sandbox['capabilities']>>>
				>,
			subscriptions: (state) =>
				worker.request('subscriptions', { state }) as Promise<
					Awaited<ReturnType<NonNullable<Sandbox['subscriptions']>>>
				>,
			runProcedure: (name, params, handle) =>
				worker.request('runProcedure', { name, params, state: handle.state }, { handle })
		}
	}
}

function cacheKey(code: string): string {
	return createHash('sha256').update(code).digest('hex')
}

function workerFor(key: string, code: string): Promise<WorkerClient> {
	let worker = workers.get(key)
	if (!worker) {
		worker = Promise.resolve(new WorkerClient(code, () => workers.delete(key)))
		workers.set(key, worker)
	}
	return worker
}

class WorkerClient {
	private readonly worker: Worker
	private nextId = 0
	private readonly pending = new Map<string, Pending>()

	constructor(code: string, onDead: () => void) {
		const source = workerSource(dataUrl(code))
		this.worker = new Worker(new URL(dataUrl(source)))
		this.worker.on('message', (message: WorkerMessage) => this.onMessage(message))
		this.worker.on('error', (error) => {
			onDead()
			this.rejectAll(error)
		})
		this.worker.on('exit', (code) => {
			if (code === 0) return
			onDead()
			this.rejectAll(new Error(`sandbox worker exited: ${code}`))
		})
	}

	request(
		type:
			| 'dispatch'
			| 'initialState'
			| 'actions'
			| 'capabilities'
			| 'subscriptions'
			| 'runProcedure',
		payload: object,
		services?: { handle?: RawAppHandle }
	): Promise<unknown> {
		const id = String(this.nextId++)
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject, handle: services?.handle })
			this.worker.postMessage({ type, id, ...payload })
		})
	}

	private onMessage(message: WorkerMessage): void {
		if (message.type === 'result' || message.type === 'error') {
			const pending = this.pending.get(message.id)
			if (!pending) return
			this.pending.delete(message.id)
			if (message.type === 'error') pending.reject(fromWire(message.error))
			else pending.resolve(message.result)
			return
		}

		const pending = this.pending.get(message.id)
		const reply = (type: 'hostResult' | 'hostError', value: unknown) => {
			this.worker.postMessage({
				type,
				callId: message.callId,
				...(type === 'hostResult' ? { result: value } : { error: toWire(value) })
			})
		}
		void (async () => {
			try {
				const handle = handleOf(pending)
				if (message.type === 'dispatch') {
					reply('hostResult', await handle.dispatch(message.message))
				} else if (message.type === 'settled') {
					reply('hostResult', await handle.settled(message.seq, message.opts))
				} else {
					reply(
						'hostResult',
						await handle.invoke(message.capability, message.method, ...message.args)
					)
				}
			} catch (error) {
				reply('hostError', error)
			}
		})()
	}

	private rejectAll(error: Error): void {
		for (const [, pending] of this.pending) pending.reject(error)
		this.pending.clear()
	}
}

function handleOf(pending: Pending | undefined): RawAppHandle {
	if (!pending?.handle) throw new Error('procedure handle unavailable')
	return pending.handle
}

function dataUrl(source: string): string {
	return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}

function workerSource(appUrl: string): string {
	return `import { parentPort } from 'node:worker_threads'
import { app } from ${JSON.stringify(appUrl)}
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
		parentPort.postMessage({ type, id, callId, ...payload })
	})
}
parentPort.on('message', async (msg) => {
	if (msg.type === 'hostResult' || msg.type === 'hostError') {
		const p = pending.get(msg.callId)
		if (!p) return
		pending.delete(msg.callId)
		if (msg.type === 'hostError') p.reject(errorFromWire(msg.error))
		else p.resolve(msg.result)
		return
	}
	try {
		if (msg.type === 'initialState') {
			parentPort.postMessage({ type: 'result', id: msg.id, result: app.initialState })
			return
		}
		if (msg.type === 'actions') {
			parentPort.postMessage({ type: 'result', id: msg.id, result: app.actions ?? {} })
			return
		}
		if (msg.type === 'capabilities') {
			parentPort.postMessage({ type: 'result', id: msg.id, result: app.capabilities ?? {} })
			return
		}
		if (msg.type === 'subscriptions') {
			parentPort.postMessage({ type: 'result', id: msg.id, result: app.subscriptions?.(msg.state) ?? [] })
			return
		}
		if (msg.type === 'runProcedure') {
			const handle = {
				state: msg.state,
				dispatch: (message) => hostCall(msg.id, 'dispatch', { message }),
				settled: (seq, opts) => hostCall(msg.id, 'settled', { seq, opts }),
				invoke: (capability, method, ...args) =>
					hostCall(msg.id, 'invoke', { capability, method, args })
			}
			parentPort.postMessage({
				type: 'result',
				id: msg.id,
				result: await app.runProcedure(msg.name, msg.params, handle)
			})
			return
		}
		const result = await app.dispatch(msg.action, { state: msg.state })
		parentPort.postMessage({ type: 'result', id: msg.id, result })
	} catch (error) {
		parentPort.postMessage({ type: 'error', id: msg.id, error: errorToWire(error) })
	}
})
`
}
