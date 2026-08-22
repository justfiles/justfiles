import { volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { buildSync } from 'esbuild'
import { expect, test } from 'vitest'
import { appBundleFromMemory } from './app.ts'
import { capabilityRegistry } from './capabilities/registry.ts'
import { volumeCapability } from './capabilities/volume/host.ts'
import { type GetSandbox, kernel } from './kernel.ts'
import source from './test-bundle/tree-watch.ts?raw'

// The bug this pins, end to end over a REAL volume and the REAL volume capability:
// a bulk fs operation (delete a heavy folder, import a vault) used to wake every
// app watching the tree once per entry, and each wake is a full dispatch. The
// fan-out stays bounded, and a state read does not join the reducer queue.

const code = buildSync({
	stdin: {
		contents: source,
		loader: 'ts',
		resolveDir: new URL('./test-bundle', import.meta.url).pathname
	},
	bundle: true,
	write: false,
	format: 'esm'
}).outputFiles[0].text

const APP_ID = 'tree'

// The reducer really runs out of process (a Worker inside a sandboxed frame), so a
// dispatch is a message round trip plus a state clone — never free. `runDelayMs`
// models that hop: it is what makes "one queued dispatch per entry" the backlog it
// is in the browser, rather than something a same-process import outruns. `runs`
// counts reduces, which is how we measure what a mount had to wait behind.
function makeSandbox(runDelayMs = 0) {
	const counter = { runs: 0 }
	const sandbox: GetSandbox = async ({ code }) => {
		const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
		return {
			run: async (message, ctx) => {
				counter.runs++
				if (runDelayMs) await new Promise((r) => setTimeout(r, runDelayMs))
				return mod.app.dispatch(message, ctx)
			},
			initialState: async () => mod.app.initialState,
			actions: async () => mod.app.actions ?? {},
			capabilities: async () => mod.app.capabilities ?? {},
			subscriptions: async (state) => mod.app.subscriptions?.(state) ?? []
		}
	}
	return { sandbox, counter }
}

async function boot(runDelayMs = 0) {
	const fs = volume(memStore())
	const { sandbox, counter } = makeSandbox(runDelayMs)
	const k = kernel({
		fs,
		sandbox,
		clock: {},
		capabilities: capabilityRegistry({
			volume: volumeCapability(fs, { systemAllowlist: [APP_ID] })
		})
	})
	await k.install(appBundleFromMemory({ id: APP_ID, name: 'Tree', app: code }))
	// One touch warms the stream, so the watch is live before the bulk operation.
	await k.dispatch(APP_ID, { type: 'noop', params: {} })
	return { fs, kernel: k, counter }
}

const settle = () => new Promise((r) => setTimeout(r, 300))

async function fill(fs: Awaited<ReturnType<typeof boot>>['fs'], n: number) {
	await fs.mkdir('/heavy', { recursive: true })
	for (let i = 0; i < n; i++) await fs.writeFile(`/heavy/f${i}.md`, new Uint8Array([1]))
}

test('a bulk fs operation wakes a tree-watching app a bounded number of times', async () => {
	const { fs, kernel: k } = await boot()

	const N = 400
	await fill(fs, N)
	await settle()

	const before = ((await k.state(APP_ID)) as { wakes: number }).wakes
	await fs.rm('/heavy', { recursive: true })
	await settle()
	const wakes = ((await k.state(APP_ID)) as { wakes: number }).wakes - before

	// At least one, or the app would still be showing a folder that is gone.
	expect(wakes).toBeGreaterThanOrEqual(1)
	// A wake per entry is the bug. The bound is what matters, not an exact count:
	// the watch thins the burst by time, and the kernel folds whatever survives into
	// one in-flight reduce plus one trailing one.
	expect(wakes).toBeLessThan(N / 10)
	expect(await fs.exists('/heavy')).toBe(false)
})

test('a state read does not wait for a reducer already in flight', async () => {
	const { kernel: k, counter } = await boot(200)
	const before = counter.runs
	const dispatch = k.dispatch(APP_ID, { type: 'noop', params: {} })
	while (counter.runs === before) await new Promise((resolve) => setTimeout(resolve, 1))

	const read = await Promise.race([
		k.state(APP_ID).then(() => 'read'),
		new Promise((resolve) => setTimeout(() => resolve('blocked'), 50))
	])
	expect(read).toBe('read')
	await dispatch
})
