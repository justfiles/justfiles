import { newWebSocketRpcSession } from 'capnweb'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { WebSocket } from 'ws'
import { type Backend, type Served, serve } from './server.ts'

const apps = [{ id: 'app.counter', name: 'Counter', glyph: 'C' }]
const entries = [{ name: 'applications' }, { name: 'state' }]
const guiSource = 'export const gui = { mount() {} }'

// A mock kernel: one in-memory app whose dispatch increments a counter and pushes
// the new state to every subscriber — enough to round-trip the berth.
function mockBackend(): Backend {
	let state: { count: number } = { count: 0 }
	const listeners = new Set<(s: unknown) => void>()
	return {
		list: async () => apps,
		ls: async () => entries,
		gui: async (id) => {
			if (id !== 'app.counter') throw new Error('not found')
			return new TextEncoder().encode(guiSource)
		},
		state: async () => state,
		dispatch: async () => {
			state = { count: state.count + 1 }
			for (const l of listeners) l(state)
			return state
		},
		subscribe: (_id, onState) => {
			listeners.add(onState)
			return () => listeners.delete(onState)
		}
	}
}

let served: Served

beforeAll(async () => {
	served = await serve(mockBackend(), { token: 'secret' })
})
afterAll(() => served.close())

function open(token: string): Promise<WebSocket> {
	const ws = new WebSocket(`ws://127.0.0.1:${served.port}/?token=${token}`)
	return new Promise((resolve, reject) => {
		ws.once('open', () => resolve(ws))
		ws.once('error', reject)
	})
}

function request(ws: WebSocket, message: unknown): Promise<unknown> {
	const reply = new Promise((resolve) =>
		ws.once('message', (data) => resolve(JSON.parse(data.toString())))
	)
	ws.send(JSON.stringify(message))
	return reply
}

test('serves the catalog to a client with the right token', async () => {
	const ws = await open('secret')
	expect(await request(ws, { type: 'list' })).toEqual({ type: 'catalog', apps })
	ws.close()
})

test('serves a Volume directory listing for a debug ls', async () => {
	const ws = await open('secret')
	expect(await request(ws, { type: 'ls', path: '/' })).toEqual({ type: 'ls', entries })
	ws.close()
})

test('broadcastCatalog pushes a fresh catalog to every launcher socket', async () => {
	const ws = await open('secret')
	const pushed = new Promise((resolve) =>
		ws.once('message', (data) => resolve(JSON.parse(data.toString())))
	)
	await served.broadcastCatalog()
	expect(await pushed).toEqual({ type: 'catalog', apps })
	ws.close()
})

test('rejects a client with the wrong token', async () => {
	const ws = new WebSocket(`ws://127.0.0.1:${served.port}/?token=wrong`)
	const code = await new Promise((resolve) => ws.once('close', resolve))
	expect(code).toBeGreaterThanOrEqual(1000)
})

test('serves the app shell with the importmap, boot script, and injected config', async () => {
	const res = await fetch(`http://127.0.0.1:${served.port}/app/app.counter?token=secret`)
	expect(res.headers.get('content-type')).toContain('text/html')
	const html = await res.text()
	expect(html).toContain('importmap')
	expect(html).toContain('/vendor/boot.js')
	expect(html).toContain('/design/mac.css') // links the platform style
	expect(html).toContain('"app.counter"') // injected app id
	expect(html).toContain('"secret"') // injected token
})

test('serves the platform style and the design system it imports', async () => {
	const mac = await fetch(`http://127.0.0.1:${served.port}/design/mac.css`)
	expect(mac.headers.get('content-type')).toContain('text/css')
	const css = await mac.text()
	expect(css).toContain(':where(html, body, #root)') // document defaults for mini-app shells
	expect(css).toContain(':where(button)') // the native-control layer
	const design = await fetch(`http://127.0.0.1:${served.port}/design/design.css`)
	expect(await design.text()).toContain('.ds-window') // a design-system component class
})

test('404s an unexported design asset', async () => {
	const res = await fetch(`http://127.0.0.1:${served.port}/design/nope.css`)
	expect(res.status).toBe(404)
})

test('serves gui.js bytes from the backend (the Volume)', async () => {
	const res = await fetch(`http://127.0.0.1:${served.port}/app/app.counter/gui.js`)
	expect(res.headers.get('content-type')).toContain('javascript')
	expect(await res.text()).toBe(guiSource)
})

test('404s an unknown app gui', async () => {
	const res = await fetch(`http://127.0.0.1:${served.port}/app/missing/gui.js`)
	expect(res.status).toBe(404)
})

test('omits the React core preload for a pure-DOM app', async () => {
	// guiSource imports no React, so the shell must not preload the ~190 KB core.
	const html = await (await fetch(`http://127.0.0.1:${served.port}/app/app.counter`)).text()
	expect(html).toContain('/vendor/boot.js') // boot is always preloaded
	expect(html).not.toContain('/vendor/core.js')
})

test('builds and serves the shared-React vendor modules', async () => {
	const core = await (await fetch(`http://127.0.0.1:${served.port}/vendor/core.js`)).text()
	expect(core).toContain('__quayReact') // sets the shared global
	const react = await (await fetch(`http://127.0.0.1:${served.port}/vendor/react.js`)).text()
	expect(react).toContain('export default') // the React object
	expect(react).toMatch(/\buseState\b/) // a named hook export
	const boot = await (await fetch(`http://127.0.0.1:${served.port}/vendor/boot.js`)).text()
	expect(boot).toContain('/berth?app=') // opens the berth
})

test('a berth round-trips state/dispatch/subscribe over Cap’n Web', async () => {
	const ws = new WebSocket(`ws://127.0.0.1:${served.port}/berth?app=app.counter&token=secret`)
	const berth = newWebSocketRpcSession<{
		state(): Promise<{ count: number }>
		dispatch(message: unknown): Promise<unknown>
		subscribe(onState: (s: unknown) => void): Promise<() => void>
	}>(ws as never)

	expect(await berth.state()).toEqual({ count: 0 })

	let pushed: (s: unknown) => void = () => {}
	const updated = new Promise<unknown>((resolve) => {
		pushed = resolve
	})
	const unsub = await berth.subscribe((s) => pushed(s))
	await berth.dispatch({ type: 'increment' })
	expect(await updated).toEqual({ count: 1 })

	await unsub()
	ws.close()
})

test('rejects a berth with the wrong token', async () => {
	const ws = new WebSocket(`ws://127.0.0.1:${served.port}/berth?app=app.counter&token=wrong`)
	const code = await new Promise((resolve) => ws.once('close', resolve))
	expect(code).toBeGreaterThanOrEqual(1000)
})
