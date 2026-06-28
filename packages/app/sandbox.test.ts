import { Worker } from 'node:worker_threads'
import { expect, test } from 'vitest'
import type { Message, RawAppHandle } from './index.ts'
import { sandboxClient, sandboxWorkerSource } from './sandbox.ts'

// Boots a real `node:worker_thread` from `sandboxWorkerSource(..., 'node')` and
// drives it through `sandboxClient` — the exact Node-host path — so the shared
// host↔isolate protocol (request/reply + the procedure host-call bridge) is
// exercised end-to-end, not just typechecked.

const APP = `export const app = {
	initialState: { count: 0 },
	actions: { inc: { type: 'inc' } },
	dispatch(action, ctx) {
		const next = action.type === 'inc' ? ctx.state.count + 1 : ctx.state.count
		return { state: { count: next }, result: 'ok' }
	},
	async runProcedure(name, params, handle) {
		if (name === 'echo') return { echoed: await handle.invoke('test', 'ping', params.value) }
		return null
	}
}`

function dataUrl(source: string): string {
	return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}

function boot(): { sandbox: ReturnType<typeof sandboxClient>['sandbox']; worker: Worker } {
	const worker = new Worker(new URL(dataUrl(sandboxWorkerSource(dataUrl(APP), 'node'))))
	const { sandbox, fail } = sandboxClient({
		post: (message) => worker.postMessage(message),
		onMessage: (handler) => worker.on('message', handler)
	})
	worker.on('error', fail)
	return { sandbox, worker }
}

test('node worker sandbox: initialState + dispatch round-trip', async () => {
	const { sandbox, worker } = boot()
	try {
		expect(await sandbox.initialState?.()).toEqual({ count: 0 })
		const result = await sandbox.run({ type: 'inc' } as Message, { state: { count: 4 } })
		expect(result).toMatchObject({ state: { count: 5 }, result: 'ok' })
	} finally {
		await worker.terminate()
	}
})

test('node worker sandbox: procedure host-call bridge', async () => {
	const { sandbox, worker } = boot()
	const handle: RawAppHandle = {
		state: { count: 0 },
		dispatch: async () => ({ seq: 1 }),
		settled: async () => undefined,
		invoke: async (capability, method, ...args) => `${capability}.${method}:${args.join(',')}`
	}
	try {
		expect(await sandbox.runProcedure?.('echo', { value: 'hi' }, handle)).toEqual({
			echoed: 'test.ping:hi'
		})
	} finally {
		await worker.terminate()
	}
})

// A self-contained reducer bundle (the SDK already inlined by the compile) loads and runs
// off a data: URL — no spawn-time link step. Mirrors what the compile now emits.
test('self-contained reducer with an inlined SDK helper runs in the worker', async () => {
	const REDUCER = `const greet = (name) => 'hi ' + name
export const app = {
	initialState: { msg: '' },
	dispatch(action, ctx) { return { state: { msg: greet(action.type) }, result: 'ok' } }
}`
	const worker = new Worker(new URL(dataUrl(sandboxWorkerSource(dataUrl(REDUCER), 'node'))))
	const { sandbox, fail } = sandboxClient({
		post: (message) => worker.postMessage(message),
		onMessage: (handler) => worker.on('message', handler)
	})
	worker.on('error', fail)
	try {
		const result = await sandbox.run({ type: 'world' } as Message, { state: { msg: '' } })
		expect(result).toMatchObject({ state: { msg: 'hi world' }, result: 'ok' })
	} finally {
		await worker.terminate()
	}
})
