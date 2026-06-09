import { appBundleFromMemory, type GetSandbox, kernel } from '@justfiles/app'
import { type Capability, capabilityRegistry } from '@justfiles/app/capabilities'
import { volumeCapability } from '@justfiles/app/capabilities/volume/host'
import { memStorage, volume } from '@justfiles/fs'
import { buildSync } from 'esbuild'
import { expect, test } from 'vitest'

// Slice 11 acceptance — the subscribe path end to end, through the REAL pieces:
// the finder bundle declaring `volume.watch` over its open file, the package
// kernel/reconciler, and the host `volumeCapability` driving a real `vol.watch`.
// A change to the watched file reaches the app as exactly one reduced message,
// and leaving the watch (clear) stops the stream.

// Compile the real finder app (with its deps) the same way the sandbox would.
const code = buildSync({
	entryPoints: [new URL('../../../packages/app-finder/src/app.ts', import.meta.url).pathname],
	bundle: true,
	write: false,
	format: 'esm'
}).outputFiles[0].text

const sandbox: GetSandbox = async ({ code }) => {
	const mod = await import(`data:text/javascript,${encodeURIComponent(code)}`)
	return {
		run: (message, ctx) => mod.app.dispatch(message, ctx),
		initialState: async () => mod.app.initialState,
		actions: async () => mod.app.actions ?? {},
		capabilities: async () => mod.app.capabilities ?? {},
		runProcedure: (name, params, handle) => mod.app.runProcedure(name, params, handle),
		subscriptions: async (state) => mod.app.subscriptions?.(state) ?? []
	}
}

// Wrap the real volume unit to count live watch streams — the host start is
// fire-and-forget through the reconciler, so the test waits on this before it
// writes (the only timing the watch path is sensitive to). Behaviour is the
// real capability's; the probe only observes establishment/teardown.
function probe(base: Capability): { cap: Capability; live: () => number } {
	let live = 0
	return {
		live: () => live,
		cap: {
			invoke: (call) => base.invoke(call),
			subscribe: async (call, emit) => {
				const unsub = await base.subscribe(call, emit)
				live++
				return () => {
					live--
					unsub()
				}
			}
		}
	}
}

async function until(cond: () => boolean | Promise<boolean>, label: string): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (await cond()) return
		await new Promise((r) => setTimeout(r, 2))
	}
	throw new Error(`timeout: ${label}`)
}
const tick = () => new Promise((r) => setTimeout(r, 10))
const enc = new TextEncoder()

test('finder watches the open file: one fileChanged per write, stops on clear', async () => {
	const fs = volume(memStorage())
	await fs.writeFile('/notes.txt', enc.encode('hello'))

	const v = probe(volumeCapability(fs, { systemAllowlist: ['app.frieren.finder'] }))
	const k = kernel({ fs, sandbox, clock: {}, capabilities: capabilityRegistry({ volume: v.cap }) })
	// Finder declares the `system` scope, allowlisted only for `app.frieren.finder`.
	const id = await k.install(
		appBundleFromMemory({ id: 'app.frieren.finder', name: 'Finder', app: code })
	)

	// Viewing a file declares the watch (`subscriptions(state)`); the reconciler
	// opens it. No watch until then.
	expect(v.live()).toBe(0)
	await k.dispatch(id, { type: 'setView', params: { path: '/notes.txt' } })
	await until(() => v.live() === 1, 'watch established')

	const rev = async () => ((await k.state(id)) as { revision: number }).revision
	expect(await rev()).toBe(0)

	// An external write to the watched file folds in as exactly one `fileChanged`.
	await fs.writeFile('/notes.txt', enc.encode('changed'))
	await until(async () => (await rev()) === 1, 'one fileChanged delivered')
	await tick()
	expect(await rev()).toBe(1)

	// Leaving the watch (clear) tears the stream down — further writes deliver nothing.
	await k.dispatch(id, { type: 'clear', params: {} })
	await until(() => v.live() === 0, 'watch stopped on clear')
	await fs.writeFile('/notes.txt', enc.encode('again'))
	await tick()
	expect(await rev()).toBe(1)
})
