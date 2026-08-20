import { appBundleFromMemory, type GetSandbox, kernel } from '@justfiles/app'
import { type Capability, capabilityRegistry } from '@justfiles/app/capabilities'
import { volumeCapability } from '@justfiles/app/capabilities/volume/host'
import { volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { buildSync } from 'esbuild'
import { expect, test } from 'vitest'

// Slice 11 acceptance — the subscribe path end to end, through the REAL pieces:
// the files bundle declaring `volume.watch` over its open file, the package
// kernel/reconciler, and the host `volumeCapability` driving a real `vol.watch`.
// A change to the watched file reaches the app as exactly one reduced message,
// and leaving the watch (clear) stops the stream.

// Compile the real files app (with its deps) the same way the sandbox would.
const code = buildSync({
	entryPoints: [new URL('../../../packages/app-files/src/app.ts', import.meta.url).pathname],
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

test('files watches the open file: one fileChanged per write, stops on clear', async () => {
	const fs = volume(memStore())
	await fs.writeFile('/notes.txt', enc.encode('hello'))

	const v = probe(volumeCapability(fs, { systemAllowlist: ['justfiles.files'] }))
	const k = kernel({ fs, sandbox, clock: {}, capabilities: capabilityRegistry({ volume: v.cap }) })
	// Files declares the `system` scope, allowlisted only for `justfiles.files`.
	const id = await k.install(
		appBundleFromMemory({ id: 'justfiles.files', name: 'Files', app: code })
	)

	// The recursive tree watch is always declared (it drives auto-refresh); the
	// reconciler opens it on install. Viewing a file declares a SECOND, single-path
	// watch over the open file (`subscriptions(state)`).
	await until(() => v.live() === 1, 'recursive tree watch established')
	await k.dispatch(id, { type: 'setView', params: { path: '/notes.txt' } })
	await until(() => v.live() === 2, 'file watch established')

	const rev = async () => ((await k.state(id)) as { revision: number }).revision
	expect(await rev()).toBe(0)

	// An external CONTENT edit to the watched file folds in as exactly one
	// `fileChanged`. It doesn't reshape the tree, so the recursive watch stays
	// silent and the revision lands at exactly 1.
	await fs.writeFile('/notes.txt', enc.encode('changed'))
	await until(async () => (await rev()) === 1, 'one fileChanged delivered')
	await tick()
	expect(await rev()).toBe(1)

	// Leaving the file (clear) tears down the single-path watch; the recursive
	// tree watch persists, so further content writes deliver no `fileChanged`.
	await k.dispatch(id, { type: 'clear', params: {} })
	await until(() => v.live() === 1, 'file watch stopped on clear')
	await fs.writeFile('/notes.txt', enc.encode('again'))
	await tick()
	expect(await rev()).toBe(1)
})

// Regression: a kernel with NO GUI (the server, where the agent runs) never
// kicks a `refresh`, so the file list must converge on the recursive watch
// alone. The scan is `.coalesce()`d, so `treeChanged` can always emit it and the
// runtime single-flights — there is no persisted "loading" flag to strand the
// app in a permanent "Loading…" (the old bug: a `treeChanged` before any scan
// latched a rescan that never ran).
test('files converges from the recursive watch alone, with no refresh/GUI', async () => {
	const fs = volume(memStore())
	await fs.writeFile('/a.txt', enc.encode('a'))

	const v = probe(volumeCapability(fs, { systemAllowlist: ['justfiles.files'] }))
	const k = kernel({ fs, sandbox, clock: {}, capabilities: capabilityRegistry({ volume: v.cap }) })
	const id = await k.install(
		appBundleFromMemory({ id: 'justfiles.files', name: 'Files', app: code })
	)
	await until(() => v.live() === 1, 'recursive tree watch established')

	// No dispatch of `refresh` — mimic the server. The initial state carries an
	// empty file list; nothing has scanned yet.
	const files = async () => ((await k.state(id)) as { files: Array<{ path: string }> }).files
	expect(await files()).toEqual([])

	// A structural change fires the recursive watch -> treeChanged -> a scan that
	// actually runs (before this fix it deadlocked, emitting no scan).
	await fs.writeFile('/b.txt', enc.encode('b'))
	await until(async () => (await files()).length > 0, 'file list populated from the watch')
	const paths = (await files()).map((f) => f.path)
	expect(paths).toContain('/a.txt')
	expect(paths).toContain('/b.txt')
})
