// Behavior tests for the injected `window.app` SDK (sdk.js). The file ships
// as a plain script — these tests load its source into a hand-rolled window
// stub so they can drive the postMessage <→> lifecycle flow end-to-end without
// a real DOM.

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

type MessageListener = (event: { source: unknown; data: unknown }) => void

interface AppShape {
	version: number
	lifecycle: { onStart(cb: () => void): () => void }
	volume: {
		readText(path: string): Promise<string>
		writeText(path: string, data: string): Promise<void>
		readFile(path: string): Promise<Uint8Array>
		writeFile(path: string, bytes: Uint8Array): Promise<void>
	}
}

interface FakeWindow {
	app?: AppShape
	addEventListener(type: 'message', fn: MessageListener): void
	parent: { postMessage(message: unknown, targetOrigin: string): void }
}

interface RpcRequest {
	jsonrpc: '2.0'
	id: string
	method: string
	params: Record<string, unknown>
}

interface Harness {
	win: FakeWindow
	dispatch: (data: unknown, source?: unknown) => void
	parentSent: RpcRequest[]
}

const SDK_SOURCE = readFileSync(path.join(import.meta.dir, 'sdk.js'), 'utf8')

function setup(): Harness {
	const listeners: MessageListener[] = []
	const parentSent: RpcRequest[] = []
	const parent = {
		postMessage(message: unknown) {
			parentSent.push(message as RpcRequest)
		}
	}
	const win: FakeWindow = {
		addEventListener(type, fn) {
			if (type === 'message') listeners.push(fn)
		},
		parent
	}
	// SDK references `window` directly; `new Function('window', ...)` shadows
	// the host `window` so the same source runs in this isolated stub.
	new Function('window', 'queueMicrotask', 'console', SDK_SOURCE)(win, queueMicrotask, console)
	return {
		win,
		parentSent,
		dispatch(data, source = parent) {
			for (const fn of listeners) fn({ source, data })
		}
	}
}

function uint8ToBase64(bytes: Uint8Array): string {
	let str = ''
	for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i] ?? 0)
	return btoa(str)
}

function base64ToUint8(b64: string): Uint8Array {
	const str = atob(b64)
	const out = new Uint8Array(str.length)
	for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i)
	return out
}

function respond(harness: Harness, frame: RpcRequest, result: unknown) {
	harness.dispatch({ jsonrpc: '2.0', id: frame.id, result })
}

function rejectRpc(harness: Harness, frame: RpcRequest, message: string) {
	harness.dispatch({ jsonrpc: '2.0', id: frame.id, error: { message } })
}

test('installs window.app with API version 1', () => {
	const { win } = setup()
	expect(win.app?.version).toBe(1)
	expect(typeof win.app?.lifecycle.onStart).toBe('function')
})

test('onStart fires when host sends lifecycle start notification', () => {
	const { win, dispatch } = setup()
	let calls = 0
	win.app?.lifecycle.onStart(() => {
		calls++
	})
	dispatch({ jsonrpc: '2.0', method: 'app.lifecycle', params: { event: 'start' } })
	expect(calls).toBe(1)
})

test('onStart fires only once even if start arrives repeatedly', () => {
	const { win, dispatch } = setup()
	let calls = 0
	win.app?.lifecycle.onStart(() => {
		calls++
	})
	const frame = { jsonrpc: '2.0', method: 'app.lifecycle', params: { event: 'start' } }
	dispatch(frame)
	dispatch(frame)
	expect(calls).toBe(1)
})

test('onStart registered after start runs in a microtask', async () => {
	const { win, dispatch } = setup()
	dispatch({ jsonrpc: '2.0', method: 'app.lifecycle', params: { event: 'start' } })
	let called = false
	win.app?.lifecycle.onStart(() => {
		called = true
	})
	expect(called).toBe(false)
	await Promise.resolve()
	expect(called).toBe(true)
})

test('multiple onStart callbacks all fire in registration order', () => {
	const { win, dispatch } = setup()
	const log: string[] = []
	win.app?.lifecycle.onStart(() => log.push('a'))
	win.app?.lifecycle.onStart(() => log.push('b'))
	win.app?.lifecycle.onStart(() => log.push('c'))
	dispatch({ jsonrpc: '2.0', method: 'app.lifecycle', params: { event: 'start' } })
	expect(log).toEqual(['a', 'b', 'c'])
})

test('unsubscribe before start prevents the callback from firing', () => {
	const { win, dispatch } = setup()
	let called = false
	const off = win.app?.lifecycle.onStart(() => {
		called = true
	})
	off?.()
	dispatch({ jsonrpc: '2.0', method: 'app.lifecycle', params: { event: 'start' } })
	expect(called).toBe(false)
})

test('a throwing callback does not block the next callback', () => {
	const { win, dispatch } = setup()
	const log: string[] = []
	win.app?.lifecycle.onStart(() => {
		throw new Error('boom')
	})
	win.app?.lifecycle.onStart(() => log.push('ok'))
	dispatch({ jsonrpc: '2.0', method: 'app.lifecycle', params: { event: 'start' } })
	expect(log).toEqual(['ok'])
})

test('ignores frames whose source is not the parent window', () => {
	const { win, dispatch } = setup()
	let called = 0
	win.app?.lifecycle.onStart(() => {
		called++
	})
	dispatch({ jsonrpc: '2.0', method: 'app.lifecycle', params: { event: 'start' } }, { rogue: true })
	expect(called).toBe(0)
})

test('ignores non-JSON-RPC frames and unknown methods', () => {
	const { win, dispatch } = setup()
	let called = 0
	win.app?.lifecycle.onStart(() => {
		called++
	})
	dispatch({ jsonrpc: '2.0', method: 'app.bogus', params: { event: 'start' } })
	dispatch({ method: 'app.lifecycle', params: { event: 'start' } })
	dispatch('not an object')
	dispatch(null)
	expect(called).toBe(0)
})

test('ignores lifecycle frames with unknown events', () => {
	const { win, dispatch } = setup()
	let called = 0
	win.app?.lifecycle.onStart(() => {
		called++
	})
	dispatch({ jsonrpc: '2.0', method: 'app.lifecycle', params: { event: 'pause' } })
	expect(called).toBe(0)
})

// ── volume bridge ────────────────────────────────────────────────────────

test('readText sends app.volume.readText and resolves with the result', async () => {
	const harness = setup()
	const { win, parentSent } = harness
	const promise = win.app!.volume.readText('greeting.txt')
	expect(parentSent.length).toBe(1)
	const frame = parentSent[0]!
	expect(frame.method).toBe('app.volume.readText')
	expect(frame.params).toEqual({ path: 'greeting.txt' })
	respond(harness, frame, 'hello world')
	expect(await promise).toBe('hello world')
})

test('writeText sends string payload and resolves on null result', async () => {
	const harness = setup()
	const { win, parentSent } = harness
	const promise = win.app!.volume.writeText('/state.json', '{"n":1}')
	const frame = parentSent[0]!
	expect(frame.method).toBe('app.volume.writeText')
	expect(frame.params).toEqual({ path: '/state.json', data: '{"n":1}' })
	respond(harness, frame, null)
	await expect(promise).resolves.toBeUndefined()
})

test('writeText rejects when host responds with error', async () => {
	const harness = setup()
	const { win, parentSent } = harness
	const promise = win.app!.volume.writeText('bad', 'x')
	rejectRpc(harness, parentSent[0]!, 'EINVAL: path may not contain `..`')
	await expect(promise).rejects.toThrow('EINVAL: path may not contain `..`')
})

test('readFile decodes base64 payload to Uint8Array', async () => {
	const harness = setup()
	const { win, parentSent } = harness
	const bytes = new Uint8Array([0, 1, 2, 254, 255])
	const promise = win.app!.volume.readFile('blob.bin')
	respond(harness, parentSent[0]!, uint8ToBase64(bytes))
	const result = await promise
	expect(result).toBeInstanceOf(Uint8Array)
	expect(Array.from(result)).toEqual(Array.from(bytes))
})

test('writeFile encodes Uint8Array as base64 in params', async () => {
	const harness = setup()
	const { win, parentSent } = harness
	const bytes = new Uint8Array([1, 2, 3, 4, 5])
	const promise = win.app!.volume.writeFile('blob.bin', bytes)
	const frame = parentSent[0]!
	expect(frame.method).toBe('app.volume.writeFile')
	expect(frame.params.path).toBe('blob.bin')
	expect(typeof frame.params.bytes).toBe('string')
	expect(Array.from(base64ToUint8(frame.params.bytes as string))).toEqual(Array.from(bytes))
	respond(harness, frame, null)
	await promise
})

test('writeFile rejects non-Uint8Array bytes synchronously', async () => {
	const { win } = setup()
	// @ts-expect-error - intentionally wrong type at runtime
	await expect(win.app!.volume.writeFile('blob.bin', 'string')).rejects.toThrow(
		/must be a Uint8Array/
	)
})

test('readText rejects non-string paths synchronously', async () => {
	const { win } = setup()
	// @ts-expect-error - intentionally wrong type at runtime
	await expect(win.app!.volume.readText(42)).rejects.toThrow(/must be a string/)
})

test('concurrent volume calls correlate by id', async () => {
	const harness = setup()
	const { win, parentSent } = harness
	const a = win.app!.volume.readText('a.txt')
	const b = win.app!.volume.readText('b.txt')
	expect(parentSent.length).toBe(2)
	// Reply out of order to confirm correlation works.
	respond(harness, parentSent[1]!, 'B')
	respond(harness, parentSent[0]!, 'A')
	expect(await a).toBe('A')
	expect(await b).toBe('B')
})
