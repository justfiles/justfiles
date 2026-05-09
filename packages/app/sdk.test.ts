// Behavior tests for the injected `window.app` SDK (sdk.js). The file ships
// as a plain script — these tests load its source into a hand-rolled window
// stub so they can drive the postMessage <→> lifecycle flow end-to-end without
// a real DOM.

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

type MessageListener = (event: { source: unknown; data: unknown }) => void

interface FakeWindow {
	app?: { version: number; lifecycle: { onStart(cb: () => void): () => void } }
	addEventListener(type: 'message', fn: MessageListener): void
	parent: { postMessage(message: unknown, targetOrigin: string): void }
}

interface Harness {
	win: FakeWindow
	dispatch: (data: unknown, source?: unknown) => void
	parentSent: unknown[]
}

const SDK_SOURCE = readFileSync(path.join(import.meta.dir, 'sdk.js'), 'utf8')

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
	new Function('window', 'queueMicrotask', 'console', SDK_SOURCE)(win, queueMicrotask, console)
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

test('ignores lifecycle frames with unknown events', () => {
	const { win, dispatch } = setup()
	let called = 0
	win.app?.lifecycle.onStart(() => {
		called++
	})
	dispatch({ jsonrpc: '2.0', method: 'app.lifecycle', params: { event: 'pause' } })
	expect(called).toBe(0)
})
