// The host↔isolate wire protocol shared by every postMessage-based `GetSandbox`
// — a browser Web Worker and a Node `worker_thread`. The message shapes, the
// request/reply correlation, and the procedure host-call bridge are identical
// across transports; only how bytes move (and how the isolate loads `app.js`)
// differs. So each adapter shrinks to "make a worker, hand this module a
// transport." (Cloudflare's Worker Loader sandbox is RPC, not postMessage, so
// it doesn't go through here.)

import type { RawAppHandle } from './app.ts'
import { fromWire, toWire } from './capabilities/index.ts'
import type { Sandbox } from './kernel.ts'
import type { Message } from './machine.ts'

// Worker→host frames: a reply to a request (`result`/`error`), or a host-call a
// running procedure makes back into the kernel (`dispatch`/`settled`/`invoke`),
// serviced by the handle stored on the originating request. A plain reduce is
// pure and needs no host-call — it just returns its `result`.
type WorkerMessage =
	| { type: 'result'; id: string; result: unknown }
	| { type: 'error'; id: string; error: Parameters<typeof fromWire>[0] }
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

export type SandboxTransport = {
	// Send a host→worker frame.
	post: (message: unknown) => void
	// Deliver each worker→host frame to `handler`.
	onMessage: (handler: (message: unknown) => void) => void
}

// Wrap a transport as the kernel's `Sandbox`. `fail` rejects every in-flight
// request — call it when the underlying worker crashes/exits so a dead isolate
// is never silently awaited forever.
export function sandboxClient(transport: SandboxTransport): {
	sandbox: Sandbox
	fail: (error: Error) => void
} {
	let nextId = 0
	const pending = new Map<string, Pending>()

	transport.onMessage((raw) => onMessage(raw as WorkerMessage))

	const request = (type: string, payload: object, handle?: RawAppHandle): Promise<unknown> => {
		const id = String(nextId++)
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject, handle })
			transport.post({ type, id, ...payload })
		})
	}

	const sandbox: Sandbox = {
		initialState: () => request('initialState', {}),
		// The reduce is pure: only the current state crosses to the worker, and the
		// edge returns its next state + command data (no host callback).
		run: (action, ctx) =>
			request('dispatch', { action, state: ctx.state }) as ReturnType<Sandbox['run']>,
		actions: () => request('actions', {}) as ReturnType<NonNullable<Sandbox['actions']>>,
		capabilities: () =>
			request('capabilities', {}) as ReturnType<NonNullable<Sandbox['capabilities']>>,
		subscriptions: (state) =>
			request('subscriptions', { state }) as ReturnType<NonNullable<Sandbox['subscriptions']>>,
		// Procedure: only the state snapshot crosses; the handle's
		// dispatch/settled/invoke are serviced back over the transport below.
		runProcedure: (name, params, handle) =>
			request('runProcedure', { name, params, state: handle.state }, handle)
	}

	return { sandbox, fail }

	function onMessage(message: WorkerMessage): void {
		if (message.type === 'result' || message.type === 'error') {
			const p = pending.get(message.id)
			if (!p) return
			pending.delete(message.id)
			if (message.type === 'error') p.reject(fromWire(message.error))
			else p.resolve(message.result)
			return
		}
		const p = pending.get(message.id)
		const reply = (type: 'hostResult' | 'hostError', value: unknown) =>
			transport.post({
				type,
				callId: message.callId,
				...(type === 'hostResult' ? { result: value } : { error: toWire(value) })
			})
		void (async () => {
			try {
				const handle = handleOf(p)
				if (message.type === 'dispatch') reply('hostResult', await handle.dispatch(message.message))
				else if (message.type === 'settled')
					reply('hostResult', await handle.settled(message.seq, message.opts))
				else
					reply(
						'hostResult',
						await handle.invoke(message.capability, message.method, ...message.args)
					)
			} catch (error) {
				reply('hostError', error)
			}
		})()
	}

	function fail(error: Error): void {
		for (const [, p] of pending) p.reject(error)
		pending.clear()
	}
}

function handleOf(pending: Pending | undefined): RawAppHandle {
	if (!pending?.handle) throw new Error('procedure handle unavailable')
	return pending.handle
}

// The isolate-side runtime, returned as source text to inline into the worker (a
// Blob in the browser, a data: URL in Node). It imports the app bundle from
// `appUrl`, services host requests, and bridges a running procedure's host-calls
// back over the transport. `transport` selects the two primitives that differ
// between a Web Worker (`self`) and a Node worker_thread (`parentPort`).
export function sandboxWorkerSource(appUrl: string, transport: 'web' | 'node'): string {
	const head =
		transport === 'node'
			? `import { parentPort } from 'node:worker_threads'
import { app } from ${JSON.stringify(appUrl)}
const send = (m) => parentPort.postMessage(m)
const listen = (h) => parentPort.on('message', h)`
			: `import { app } from ${JSON.stringify(appUrl)}
const send = (m) => self.postMessage(m)
const listen = (h) => { self.onmessage = (e) => h(e.data) }`
	return `${head}
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
		send({ type, id, callId, ...payload })
	})
}
async function handle(msg) {
	if (msg.type === 'hostResult' || msg.type === 'hostError') {
		const p = pending.get(msg.callId)
		if (!p) return
		pending.delete(msg.callId)
		if (msg.type === 'hostError') p.reject(errorFromWire(msg.error))
		else p.resolve(msg.result)
		return
	}
	try {
		if (msg.type === 'initialState') return send({ type: 'result', id: msg.id, result: app.initialState })
		if (msg.type === 'actions') return send({ type: 'result', id: msg.id, result: app.actions ?? {} })
		if (msg.type === 'capabilities') return send({ type: 'result', id: msg.id, result: app.capabilities ?? {} })
		if (msg.type === 'subscriptions')
			return send({ type: 'result', id: msg.id, result: app.subscriptions?.(msg.state) ?? [] })
		if (msg.type === 'runProcedure') {
			const h = {
				state: msg.state,
				dispatch: (message) => hostCall(msg.id, 'dispatch', { message }),
				settled: (seq, opts) => hostCall(msg.id, 'settled', { seq, opts }),
				invoke: (capability, method, ...args) => hostCall(msg.id, 'invoke', { capability, method, args })
			}
			return send({ type: 'result', id: msg.id, result: await app.runProcedure(msg.name, msg.params, h) })
		}
		send({ type: 'result', id: msg.id, result: await app.dispatch(msg.action, { state: msg.state }) })
	} catch (error) {
		send({ type: 'error', id: msg.id, error: errorToWire(error) })
	}
}
listen(handle)
`
}
