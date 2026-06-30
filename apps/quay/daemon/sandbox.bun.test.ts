// The sandbox pool under Bun (run with `bun test` — the Bun half of the matrix; it
// needs `URL.createObjectURL` + blob-URL Workers, so it's excluded from node vitest).
// Drives REAL reducer workers: a worker is content-addressed per app bundle, pinned
// while a window is open, and an idle worker (no open window) is reaped then
// transparently re-spawned on the next dispatch. A small `idleMs` keeps it quick.

import { expect, test } from 'bun:test'
import type { Message } from '@justfiles/app/runtime'
import { sandboxPool } from './sandbox.ts'

const APP = `export const app = {
	initialState: { count: 0 },
	dispatch(action, ctx) { return { state: { count: ctx.state.count + 1 }, result: 'ok' } }
}`

const ALT = `export const app = {
	initialState: { n: 0 },
	dispatch(action, ctx) { return { state: { n: ctx.state.n + 1 }, result: 'ok' } }
}`

const idleMs = 40

function waitFor(cond: () => boolean, ms = 1500): Promise<void> {
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

test('runs a reducer off the main thread, one worker per app', async () => {
	const pool = sandboxPool({ idleMs })
	pool.retain('app.a')
	pool.retain('app.b')

	const a = await pool.get({ appId: 'app.a', code: APP })
	expect(await a.run({ type: 'inc' } as Message, { state: { count: 4 } })).toMatchObject({
		state: { count: 5 }
	})

	await pool.get({ appId: 'app.a', code: APP }) // same bytes → reuse the one worker
	expect(pool.resident()).toBe(1)
	await pool.get({ appId: 'app.b', code: ALT }) // a second app → a second worker
	expect(pool.resident()).toBe(2)

	pool.release('app.a')
	pool.release('app.b')
	await waitFor(() => pool.resident() === 0) // both reaped once idle
})

test('evicts an idle worker with no open window, then re-spawns on demand', async () => {
	const pool = sandboxPool({ idleMs })

	await pool.get({ appId: 'app.a', code: APP }) // never retained → no pinning window
	expect(pool.resident()).toBe(1)
	await waitFor(() => pool.resident() === 0) // idle timer fires → worker terminated

	pool.retain('app.a')
	const a = await pool.get({ appId: 'app.a', code: APP }) // next dispatch re-spawns it
	expect(await a.run({ type: 'inc' } as Message, { state: { count: 0 } })).toMatchObject({
		state: { count: 1 }
	})
	expect(pool.resident()).toBe(1)

	pool.release('app.a')
	await waitFor(() => pool.resident() === 0)
})

test('a worker stays resident while its app has an open window', async () => {
	const pool = sandboxPool({ idleMs })
	pool.retain('app.a')
	await pool.get({ appId: 'app.a', code: APP })

	await new Promise((r) => setTimeout(r, idleMs * 3)) // well past the idle window
	expect(pool.resident()).toBe(1) // pinned by the open window

	pool.release('app.a')
	await waitFor(() => pool.resident() === 0) // window closed → evicted
})

test('the last window closing reaps the worker; a second window keeps it pinned', async () => {
	const pool = sandboxPool({ idleMs })
	pool.retain('app.a') // window 1
	pool.retain('app.a') // window 2
	await pool.get({ appId: 'app.a', code: APP })

	pool.release('app.a') // window 1 gone — still one open, stays pinned
	await new Promise((r) => setTimeout(r, idleMs * 3))
	expect(pool.resident()).toBe(1)

	pool.release('app.a') // last window gone — idle countdown starts
	await waitFor(() => pool.resident() === 0)
})
