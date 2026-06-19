// The sandbox under Bun (run with `bun test` — the Bun half of the matrix). Same
// pool as `nodeSandbox.test.ts`, but here `#sandbox-url` resolves to the `blob:`
// side: this is the regression guard for the one runtime divergence the migration
// has. A padded (>PATH_MAX) bundle is the case that fails with `data:` URLs under
// Bun — proving the blob path is load-bearing. Excluded from the node vitest run.

import { expect, test } from 'bun:test'
import type { Message } from '@justfiles/app/runtime'
import { nodeSandbox } from './nodeSandbox.ts'

// Padded past PATH_MAX (~1 KB) — a `data:` worker URL of this size throws
// ENAMETOOLONG under Bun, so a green run means the `blob:` side is in force.
const APP = `export const app = {
	initialState: { count: 0 },
	dispatch(action, ctx) { return { state: { count: ctx.state.count + 1 }, result: 'ok' } }
}
// ${'x'.repeat(4000)}`

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

test('runs a reducer off the main thread on a >PATH_MAX bundle (blob: URLs)', async () => {
	const ns = nodeSandbox({ idleMs })
	ns.retain('app.a')
	const a = await ns.get({ appId: 'app.a', code: APP })
	expect(await a.run({ type: 'inc' } as Message, { state: { count: 4 } })).toMatchObject({
		state: { count: 5 }
	})
	expect(ns.resident()).toBe(1)
	ns.release('app.a')
	await waitFor(() => ns.resident() === 0)
})

test('evicts an idle worker, then transparently re-spawns on demand', async () => {
	const ns = nodeSandbox({ idleMs })
	await ns.get({ appId: 'app.a', code: APP }) // never retained → no pinning window
	expect(ns.resident()).toBe(1)
	await waitFor(() => ns.resident() === 0) // idle timer terminates it

	ns.retain('app.a')
	const a = await ns.get({ appId: 'app.a', code: APP }) // next dispatch re-spawns
	expect(await a.run({ type: 'inc' } as Message, { state: { count: 0 } })).toMatchObject({
		state: { count: 1 }
	})
	ns.release('app.a')
	await waitFor(() => ns.resident() === 0)
})
