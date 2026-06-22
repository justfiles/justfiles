import type { Message } from '@justfiles/app/runtime'
import { expect, test } from 'vitest'
import { nodeSandbox } from './nodeSandbox.ts'

// Drives the real `node:worker_threads` pool: a reducer runs off the main thread,
// workers are content-addressed by code, and an idle worker (no open window) is
// torn down then transparently re-spawned. A small `idleMs` keeps the test quick.

const APP = `export const app = {
	initialState: { count: 0 },
	dispatch(action, ctx) {
		return { state: { count: ctx.state.count + 1 }, result: 'ok' }
	}
}`

const ALT = `export const app = {
	initialState: { n: 0 },
	dispatch(action, ctx) { return { state: { n: ctx.state.n + 1 }, result: 'ok' } }
}`

const idleMs = 40

function waitFor(cond: () => boolean, ms = 1000): Promise<void> {
	const start = Date.now()
	return new Promise((resolve, reject) => {
		const tick = (): void => {
			if (cond()) resolve()
			else if (Date.now() - start > ms) reject(new Error('waitFor timed out'))
			else setTimeout(tick, 5)
		}
		tick()
	})
}

test('runs a reducer off the main thread, one worker per distinct bundle', async () => {
	const ns = nodeSandbox({ idleMs })
	ns.retain('app.a')
	ns.retain('app.b')

	const a = await ns.get({ appId: 'app.a', code: APP })
	expect(await a.run({ type: 'inc' } as Message, { state: { count: 4 } })).toMatchObject({
		state: { count: 5 }
	})

	await ns.get({ appId: 'app.a', code: APP }) // same bytes → reuse the one worker
	expect(ns.resident()).toBe(1)
	await ns.get({ appId: 'app.b', code: ALT }) // different bytes → a second worker
	expect(ns.resident()).toBe(2)

	ns.release('app.a')
	ns.release('app.b')
	await waitFor(() => ns.resident() === 0) // both reaped once idle
})

test('evicts an idle worker with no open window, then re-spawns on demand', async () => {
	const ns = nodeSandbox({ idleMs })

	await ns.get({ appId: 'app.a', code: APP }) // never retained → no pinning window
	expect(ns.resident()).toBe(1)
	await waitFor(() => ns.resident() === 0) // idle timer fires → worker terminated

	ns.retain('app.a')
	const a = await ns.get({ appId: 'app.a', code: APP }) // next dispatch re-spawns it
	expect(await a.run({ type: 'inc' } as Message, { state: { count: 0 } })).toMatchObject({
		state: { count: 1 }
	})
	expect(ns.resident()).toBe(1)

	ns.release('app.a')
	await waitFor(() => ns.resident() === 0)
})

test('a worker stays resident while its app has an open window', async () => {
	const ns = nodeSandbox({ idleMs })
	ns.retain('app.a')
	await ns.get({ appId: 'app.a', code: APP })

	await new Promise((r) => setTimeout(r, idleMs * 3)) // well past the idle window
	expect(ns.resident()).toBe(1) // pinned by the open window

	ns.release('app.a')
	await waitFor(() => ns.resident() === 0) // window closed → evicted
})

// The Step 12 node path: a reducer keeps its short `justfiles-sdk:` sentinel, and the
// worker's `--import` loader hook serves the SDK module from the in-memory map (handed in
// over `workerData`) — the SDK bytes never enter the per-spawn worker URL.
test('resolves a reducer SDK sentinel from the in-memory map via the loader hook', async () => {
	const SDK = `export const greet = (name) => 'hi ' + name`
	const REDUCER = `import { greet } from 'justfiles-sdk:valibot'
export const app = {
	initialState: { msg: '' },
	dispatch(action, ctx) { return { state: { msg: greet(action.type) }, result: 'ok' } }
}`
	const ns = nodeSandbox({ idleMs, sdk: async () => new Map([['valibot', SDK]]) })
	ns.retain('app.sdk')
	const a = await ns.get({ appId: 'app.sdk', code: REDUCER })
	expect(await a.run({ type: 'world' } as Message, { state: { msg: '' } })).toMatchObject({
		state: { msg: 'hi world' }
	})
	ns.release('app.sdk')
	await waitFor(() => ns.resident() === 0)
})
