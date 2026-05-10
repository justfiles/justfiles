// Behavior tests for the injected `window.app` SDK (sdk.ts). The build ships
// it as a classic-script IIFE (dist/sdk.js); these tests transpile the TS
// source with Bun and load the result into a hand-rolled window stub so they
// can drive the postMessage ⇄ lifecycle flow end-to-end without a real DOM
// and without depending on the build artifact.

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Transpiler } from 'bun'

type MessageListener = (event: { source: unknown; data: unknown }) => void

interface FakeApp {
	version: number
	lifecycle: { onStart(cb: () => void): () => void; onStop(cb: () => void): () => void }
	volume: {
		readText(path: string): Promise<string>
		writeText(path: string, text: string): Promise<void>
		readFile(path: string): Promise<Uint8Array>
		writeFile(path: string, bytes: Uint8Array): Promise<void>
	}
	capabilities: Record<string, Record<string, (input: unknown) => Promise<unknown>>>
	agent: {
		send(text: string): Promise<void>
		describe(callback: () => string | Promise<string>): void
	}
}
interface FakeWindow {
	app?: FakeApp
	addEventListener(type: 'message', fn: MessageListener): void
	parent: { postMessage(message: unknown, targetOrigin: string): void }
}

interface Harness {
	win: FakeWindow
	dispatch: (data: unknown, source?: unknown) => void
	parentSent: unknown[]
}

const SDK_SOURCE = new Transpiler({ loader: 'ts' }).transformSync(
	readFileSync(path.join(import.meta.dir, 'sdk.ts'), 'utf8')
)

function setup(): Harness {
	const listeners: MessageListener[] = []
	const parentSent: unknown[] = []
	const parent = {
		postMessage(message: unknown) {
			parentSent.push(message)
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
	new Function(
		'window',
		'queueMicrotask',
		'console',
		'btoa',
		'atob',
		'TextEncoder',
		'TextDecoder',
		SDK_SOURCE
	)(win, queueMicrotask, console, btoa, atob, TextEncoder, TextDecoder)
	return {
		win,
		parentSent,
		dispatch(data, source = parent) {
			for (const fn of listeners) fn({ source, data })
		}
	}
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

// ── volume / request-response ──────────────────────────────────────────

type RpcFrame = {
	jsonrpc: '2.0'
	id: string
	method: string
	params: { path: string; text?: string; bytes?: string }
}

const sentFrames = (h: Harness) => h.parentSent as RpcFrame[]

test('volume.writeText sends a typed request and resolves on response', async () => {
	const h = setup()
	const promise = h.win.app?.volume.writeText('notes.txt', 'hi')
	const sent = sentFrames(h)[0]
	expect(sent.method).toBe('app.volume.writeText')
	expect(sent.params).toEqual({ path: 'notes.txt', text: 'hi' })
	h.dispatch({ jsonrpc: '2.0', id: sent.id, result: null })
	await expect(promise).resolves.toBeUndefined()
})

test('volume.readText resolves with the text from the response', async () => {
	const h = setup()
	const promise = h.win.app?.volume.readText('notes.txt') as Promise<string>
	const sent = sentFrames(h)[0]
	h.dispatch({ jsonrpc: '2.0', id: sent.id, result: { text: 'hello' } })
	await expect(promise).resolves.toBe('hello')
})

test('volume.readText rejects with an error carrying the rpc code', async () => {
	const h = setup()
	const promise = h.win.app?.volume.readText('missing.txt') as Promise<string>
	const sent = sentFrames(h)[0]
	h.dispatch({ jsonrpc: '2.0', id: sent.id, error: { code: -32001, message: 'not_found' } })
	await expect(promise).rejects.toMatchObject({ message: 'not_found', code: -32001 })
})

test('volume.writeFile encodes bytes as base64 and resolves on ok', async () => {
	const h = setup()
	const bytes = new Uint8Array([0, 1, 2, 250, 255])
	const promise = h.win.app?.volume.writeFile('blob.bin', bytes)
	const sent = sentFrames(h)[0]
	expect(sent.method).toBe('app.volume.writeFile')
	expect(sent.params.path).toBe('blob.bin')
	expect(sent.params.bytes).toBe(btoa('\x00\x01\x02\xfa\xff'))
	h.dispatch({ jsonrpc: '2.0', id: sent.id, result: null })
	await expect(promise).resolves.toBeUndefined()
})

test('volume.readFile decodes base64 from the response', async () => {
	const h = setup()
	const promise = h.win.app?.volume.readFile('blob.bin') as Promise<Uint8Array>
	const sent = sentFrames(h)[0]
	const b64 = btoa('\x00\x01\x02\xfa\xff')
	h.dispatch({ jsonrpc: '2.0', id: sent.id, result: { bytes: b64 } })
	const out = await promise
	expect(Array.from(out)).toEqual([0, 1, 2, 250, 255])
})

test('volume.writeFile throws on non-Uint8Array input', () => {
	const { win } = setup()
	expect(() => win.app?.volume.writeFile('blob.bin', 'oops' as unknown as Uint8Array)).toThrow(
		TypeError
	)
})

test('out-of-band response with unknown id is ignored', () => {
	const { dispatch } = setup()
	dispatch({ jsonrpc: '2.0', id: 'never-issued', result: { text: 'oops' } })
	// no throw; nothing to assert beyond reaching this point
})

// ── capabilities / generic invocation ──────────────────────────────────

type InvokeFrame = {
	jsonrpc: '2.0'
	id: string
	method: 'app.capability.invoke'
	params: { capability: string; method: string; input: unknown }
}

test('app.capabilities.email.listUnread sends one generic invoke frame', async () => {
	const h = setup()
	const promise = h.win.app?.capabilities.email?.listUnread({ limit: 3, accountId: 'primary' })
	const sent = h.parentSent[0] as InvokeFrame
	expect(sent.method).toBe('app.capability.invoke')
	expect(sent.params).toEqual({
		capability: 'email',
		method: 'listUnread',
		input: { limit: 3, accountId: 'primary' }
	})
	h.dispatch({ jsonrpc: '2.0', id: sent.id, result: { value: [{ id: 'e1' }] } })
	await expect(promise).resolves.toEqual([{ id: 'e1' }])
})

test('app.capabilities.calendar uses the same invoke transport with calendar id', async () => {
	const h = setup()
	const promise = h.win.app?.capabilities.calendar?.listToday({ timezone: 'UTC' })
	const sent = h.parentSent[0] as InvokeFrame
	expect(sent.params.capability).toBe('calendar')
	expect(sent.params.method).toBe('listToday')
	h.dispatch({ jsonrpc: '2.0', id: sent.id, result: { value: [] } })
	await expect(promise).resolves.toEqual([])
})

test('capability denial rejects with code -32010 and capability/method data', async () => {
	const h = setup()
	const promise = h.win.app?.capabilities.email?.listUnread({})
	const sent = h.parentSent[0] as InvokeFrame
	h.dispatch({
		jsonrpc: '2.0',
		id: sent.id,
		error: {
			code: -32010,
			message: 'capability_denied',
			data: { capability: 'email', method: 'listUnread' }
		}
	})
	await expect(promise).rejects.toMatchObject({
		message: 'capability_denied',
		code: -32010,
		data: { capability: 'email', method: 'listUnread' }
	})
})

test('capability proxies are cached per id (stable identity across access)', () => {
	const { win } = setup()
	const a = win.app?.capabilities.email
	const b = win.app?.capabilities.email
	expect(a).toBe(b)
})

test('capability proxies are extensible — unknown ids produce a usable proxy', async () => {
	const h = setup()
	// Author-side: a future capability registered via module augmentation.
	// At runtime, the proxy treats every id uniformly.
	const futureCap = (
		h.win.app?.capabilities as Record<string, Record<string, (i: unknown) => Promise<unknown>>>
	).reminders
	const promise = futureCap?.list({})
	const sent = h.parentSent[0] as InvokeFrame
	expect(sent.params.capability).toBe('reminders')
	expect(sent.params.method).toBe('list')
	h.dispatch({ jsonrpc: '2.0', id: sent.id, result: { value: [] } })
	await expect(promise).resolves.toEqual([])
})

// ── agent / send ──────────────────────────────────────────────────────

type AgentFrame = {
	jsonrpc: '2.0'
	id: string
	method: 'app.agent.send'
	params: { text: string }
}

test('app.agent.send posts a typed request and resolves on null result', async () => {
	const h = setup()
	const promise = h.win.app?.agent.send('hello agent')
	const sent = h.parentSent[0] as AgentFrame
	expect(sent.method).toBe('app.agent.send')
	expect(sent.params).toEqual({ text: 'hello agent' })
	h.dispatch({ jsonrpc: '2.0', id: sent.id, result: null })
	await expect(promise).resolves.toBeUndefined()
})

test('app.agent.send rejects with the rpc error code on permission_denied', async () => {
	const h = setup()
	const promise = h.win.app?.agent.send('hi')
	const sent = h.parentSent[0] as AgentFrame
	h.dispatch({
		jsonrpc: '2.0',
		id: sent.id,
		error: { code: -32005, message: 'permission_denied', data: { permission: 'agent' } }
	})
	await expect(promise).rejects.toMatchObject({
		message: 'permission_denied',
		code: -32005,
		data: { permission: 'agent' }
	})
})

test('app.agent.send throws on non-string input', () => {
	const { win } = setup()
	expect(() => win.app?.agent.send(42 as unknown as string)).toThrow(TypeError)
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

// ── agent / describe ──────────────────────────────────────────────────

type DescribeRequest = { jsonrpc: '2.0'; id: string; method: 'app.agent.describe'; params: object }
type DescribeResponse = {
	jsonrpc: '2.0'
	id: string
	result?: { description: string | null }
	error?: { code: number; message: string }
}

const describeResponses = (h: Harness) => h.parentSent as DescribeResponse[]

test('app.agent.describe is a function on the agent object', () => {
	const { win } = setup()
	expect(typeof win.app?.agent.describe).toBe('function')
})

test('host describe request returns the callback result', async () => {
	const h = setup()
	h.win.app?.agent.describe(() => 'the app is running and showing the main screen')
	const req: DescribeRequest = {
		jsonrpc: '2.0',
		id: 'req1',
		method: 'app.agent.describe',
		params: {}
	}
	h.dispatch(req)
	await Promise.resolve()
	const sent = describeResponses(h)[0]
	expect(sent).toMatchObject({
		jsonrpc: '2.0',
		id: 'req1',
		result: { description: 'the app is running and showing the main screen' }
	})
})

test('no callback registered returns null description', async () => {
	const h = setup()
	const req: DescribeRequest = {
		jsonrpc: '2.0',
		id: 'req2',
		method: 'app.agent.describe',
		params: {}
	}
	h.dispatch(req)
	await Promise.resolve()
	const sent = describeResponses(h)[0]
	expect(sent).toMatchObject({ jsonrpc: '2.0', id: 'req2', result: { description: null } })
})

test('async describe callback is awaited before responding', async () => {
	const h = setup()
	h.win.app?.agent.describe(async () => {
		await Promise.resolve()
		return 'async description'
	})
	const req: DescribeRequest = {
		jsonrpc: '2.0',
		id: 'req3',
		method: 'app.agent.describe',
		params: {}
	}
	h.dispatch(req)
	await new Promise((r) => setTimeout(r, 0))
	const sent = describeResponses(h)[0]
	expect(sent).toMatchObject({ result: { description: 'async description' } })
})

test('throwing describe callback returns a stable error shape', async () => {
	const h = setup()
	h.win.app?.agent.describe(() => {
		throw new Error('projection_failed')
	})
	const req: DescribeRequest = {
		jsonrpc: '2.0',
		id: 'req4',
		method: 'app.agent.describe',
		params: {}
	}
	h.dispatch(req)
	await Promise.resolve()
	const sent = describeResponses(h)[0]
	expect(sent).toMatchObject({
		jsonrpc: '2.0',
		id: 'req4',
		error: { code: -32000, message: 'projection_failed' }
	})
})

test('only the last registered describe callback is active', async () => {
	const h = setup()
	h.win.app?.agent.describe(() => 'first')
	h.win.app?.agent.describe(() => 'second')
	const req: DescribeRequest = {
		jsonrpc: '2.0',
		id: 'req5',
		method: 'app.agent.describe',
		params: {}
	}
	h.dispatch(req)
	await Promise.resolve()
	const sent = describeResponses(h)[0]
	expect(sent).toMatchObject({ result: { description: 'second' } })
})

test('host describe request from unknown source is ignored', async () => {
	const h = setup()
	h.win.app?.agent.describe(() => 'should not be called')
	const req: DescribeRequest = {
		jsonrpc: '2.0',
		id: 'req6',
		method: 'app.agent.describe',
		params: {}
	}
	h.dispatch(req, { rogue: true })
	await Promise.resolve()
	expect(h.parentSent).toHaveLength(0)
})

// ── agent / tools ─────────────────────────────────────────────────────

type ToolRegisterFrame = {
	jsonrpc: '2.0'
	id: string
	method: 'app.tool.register'
	params: { name: string; description: string; schema: Record<string, unknown> }
}

type ToolInvokeRequest = {
	jsonrpc: '2.0'
	id: string
	method: 'app.tool.invoke'
	params: { callId: string; name: string; input: unknown }
}

type ToolInvokeResponse = {
	jsonrpc: '2.0'
	id: string
	result?: { callId: string; value: unknown }
	error?: { code: number; message: string }
}

test('app.agent.tools is an object with a register function', () => {
	const { win } = setup()
	expect(typeof win.app?.agent.tools).toBe('object')
	expect(typeof win.app?.agent.tools.register).toBe('function')
})

test('register sends app.tool.register RPC to host', () => {
	const h = setup()
	h.win.app?.agent.tools.register({
		name: 'highlight',
		description: 'Highlights text in the app',
		schema: { type: 'object', properties: { color: { type: 'string' } } },
		handler: () => {}
	})
	const sent = h.parentSent[0] as ToolRegisterFrame
	expect(sent.method).toBe('app.tool.register')
	expect(sent.params.name).toBe('highlight')
	expect(sent.params.description).toBe('Highlights text in the app')
	expect(sent.params.schema).toEqual({ type: 'object', properties: { color: { type: 'string' } } })
})

test('host tool.invoke request calls the registered handler and responds with result', async () => {
	const h = setup()
	h.win.app?.agent.tools.register({
		name: 'greet',
		description: 'Say hi',
		schema: {},
		handler: (input) => `hello ${(input as { name: string }).name}`
	})
	// Consume the register RPC frame
	const regFrame = h.parentSent[0] as ToolRegisterFrame
	h.dispatch({ jsonrpc: '2.0', id: regFrame.id, result: null })

	// Host invokes the tool
	const req: ToolInvokeRequest = {
		jsonrpc: '2.0',
		id: 'invoke-1',
		method: 'app.tool.invoke',
		params: { callId: 'call-abc', name: 'greet', input: { name: 'world' } }
	}
	h.dispatch(req)
	await new Promise((r) => setTimeout(r, 0))
	const resp = h.parentSent[1] as ToolInvokeResponse
	expect(resp).toMatchObject({
		jsonrpc: '2.0',
		id: 'invoke-1',
		result: { callId: 'call-abc', value: 'hello world' }
	})
})

test('host tool.invoke with async handler awaits and responds with result', async () => {
	const h = setup()
	h.win.app?.agent.tools.register({
		name: 'slow',
		description: 'Async tool',
		schema: {},
		handler: async () => {
			await Promise.resolve()
			return 42
		}
	})
	const regFrame = h.parentSent[0] as ToolRegisterFrame
	h.dispatch({ jsonrpc: '2.0', id: regFrame.id, result: null })

	const req: ToolInvokeRequest = {
		jsonrpc: '2.0',
		id: 'invoke-2',
		method: 'app.tool.invoke',
		params: { callId: 'call-slow', name: 'slow', input: {} }
	}
	h.dispatch(req)
	await new Promise((r) => setTimeout(r, 0))
	const resp = h.parentSent[1] as ToolInvokeResponse
	expect(resp).toMatchObject({ result: { value: 42 } })
})

test('host tool.invoke with unknown tool name returns tool_unavailable error', async () => {
	const h = setup()
	const req: ToolInvokeRequest = {
		jsonrpc: '2.0',
		id: 'invoke-3',
		method: 'app.tool.invoke',
		params: { callId: 'call-none', name: 'nonexistent', input: {} }
	}
	h.dispatch(req)
	await new Promise((r) => setTimeout(r, 0))
	const resp = h.parentSent[0] as ToolInvokeResponse
	expect(resp).toMatchObject({
		jsonrpc: '2.0',
		id: 'invoke-3',
		error: { code: -32020, message: 'tool_unavailable' }
	})
})

test('throwing handler returns stable tool_handler_error shape', async () => {
	const h = setup()
	h.win.app?.agent.tools.register({
		name: 'boom',
		description: 'Throws',
		schema: {},
		handler: () => {
			throw new Error('explosion')
		}
	})
	const regFrame = h.parentSent[0] as ToolRegisterFrame
	h.dispatch({ jsonrpc: '2.0', id: regFrame.id, result: null })

	const req: ToolInvokeRequest = {
		jsonrpc: '2.0',
		id: 'invoke-4',
		method: 'app.tool.invoke',
		params: { callId: 'call-boom', name: 'boom', input: {} }
	}
	h.dispatch(req)
	await new Promise((r) => setTimeout(r, 0))
	const resp = h.parentSent[1] as ToolInvokeResponse
	expect(resp).toMatchObject({
		jsonrpc: '2.0',
		id: 'invoke-4',
		error: { code: -32022, message: 'explosion' }
	})
})

test('unregister removes the tool handler so subsequent invocations return tool_unavailable', async () => {
	const h = setup()
	const off = h.win.app?.agent.tools.register({
		name: 'removable',
		description: 'Will be removed',
		schema: {},
		handler: () => 'present'
	})
	off?.()

	const req: ToolInvokeRequest = {
		jsonrpc: '2.0',
		id: 'invoke-5',
		method: 'app.tool.invoke',
		params: { callId: 'call-removed', name: 'removable', input: {} }
	}
	h.dispatch(req)
	await new Promise((r) => setTimeout(r, 0))
	const resp = h.parentSent[1] as ToolInvokeResponse
	expect(resp).toMatchObject({ error: { code: -32020, message: 'tool_unavailable' } })
})

test('register throws TypeError on invalid name', () => {
	const { win } = setup()
	expect(() =>
		win.app?.agent.tools.register({
			name: '',
			description: '',
			schema: {},
			handler: () => {}
		})
	).toThrow(TypeError)
})

// ── lifecycle / stop ──────────────────────────────────────────────────

test('onStop fires when host sends lifecycle stop notification after start', () => {
	const { win, dispatch } = setup()
	let stops = 0
	win.app?.lifecycle.onStop(() => {
		stops++
	})
	// Stop only fires after start has happened — guards against pre-start no-op.
	dispatch({ jsonrpc: '2.0', method: 'app.lifecycle', params: { event: 'start' } })
	dispatch({ jsonrpc: '2.0', method: 'app.lifecycle', params: { event: 'stop' } })
	expect(stops).toBe(1)
})

test('onStop only fires once per stop event', () => {
	const { win, dispatch } = setup()
	let stops = 0
	win.app?.lifecycle.onStop(() => {
		stops++
	})
	dispatch({ jsonrpc: '2.0', method: 'app.lifecycle', params: { event: 'start' } })
	const stop = { jsonrpc: '2.0', method: 'app.lifecycle', params: { event: 'stop' } }
	dispatch(stop)
	dispatch(stop)
	expect(stops).toBe(1)
})

test('onStop does not fire if app never started', () => {
	const { win, dispatch } = setup()
	let stops = 0
	win.app?.lifecycle.onStop(() => {
		stops++
	})
	dispatch({ jsonrpc: '2.0', method: 'app.lifecycle', params: { event: 'stop' } })
	expect(stops).toBe(0)
})

test('multiple onStop callbacks all fire, throwing one does not block the rest', () => {
	const { win, dispatch } = setup()
	const log: string[] = []
	win.app?.lifecycle.onStop(() => log.push('a'))
	win.app?.lifecycle.onStop(() => {
		throw new Error('boom')
	})
	win.app?.lifecycle.onStop(() => log.push('c'))
	dispatch({ jsonrpc: '2.0', method: 'app.lifecycle', params: { event: 'start' } })
	dispatch({ jsonrpc: '2.0', method: 'app.lifecycle', params: { event: 'stop' } })
	expect(log).toEqual(['a', 'c'])
})

test('onStop unsubscribe removes the callback', () => {
	const { win, dispatch } = setup()
	let stops = 0
	const off = win.app?.lifecycle.onStop(() => {
		stops++
	})
	off?.()
	dispatch({ jsonrpc: '2.0', method: 'app.lifecycle', params: { event: 'start' } })
	dispatch({ jsonrpc: '2.0', method: 'app.lifecycle', params: { event: 'stop' } })
	expect(stops).toBe(0)
})

test('lifecycle stop clears tool handlers — subsequent invoke returns tool_unavailable', async () => {
	const h = setup()
	let calls = 0
	h.win.app?.agent.tools.register({
		name: 'mute-me',
		description: 'Will be muted on stop',
		schema: {},
		handler: () => {
			calls++
			return 'ran'
		}
	})
	// Drain register RPC.
	const regFrame = h.parentSent[0] as ToolRegisterFrame
	h.dispatch({ jsonrpc: '2.0', id: regFrame.id, result: null })

	h.dispatch({ jsonrpc: '2.0', method: 'app.lifecycle', params: { event: 'start' } })
	h.dispatch({ jsonrpc: '2.0', method: 'app.lifecycle', params: { event: 'stop' } })

	const req: ToolInvokeRequest = {
		jsonrpc: '2.0',
		id: 'invoke-after-stop',
		method: 'app.tool.invoke',
		params: { callId: 'call-after-stop', name: 'mute-me', input: {} }
	}
	h.dispatch(req)
	await new Promise((r) => setTimeout(r, 0))
	const resp = h.parentSent[h.parentSent.length - 1] as ToolInvokeResponse
	expect(resp).toMatchObject({
		jsonrpc: '2.0',
		id: 'invoke-after-stop',
		error: { code: -32020, message: 'tool_unavailable' }
	})
	expect(calls).toBe(0)
})

test('tool.invoke from unknown source is ignored', async () => {
	const h = setup()
	h.win.app?.agent.tools.register({
		name: 'guarded',
		description: '',
		schema: {},
		handler: () => 'should not run'
	})
	const req: ToolInvokeRequest = {
		jsonrpc: '2.0',
		id: 'invoke-6',
		method: 'app.tool.invoke',
		params: { callId: 'call-rogue', name: 'guarded', input: {} }
	}
	// Dispatch from a rogue source — SDK must ignore it.
	h.dispatch(req, { rogue: true })
	await new Promise((r) => setTimeout(r, 0))
	// Only the register RPC was sent, no invoke response.
	expect(h.parentSent).toHaveLength(1)
	expect((h.parentSent[0] as ToolRegisterFrame).method).toBe('app.tool.register')
})
