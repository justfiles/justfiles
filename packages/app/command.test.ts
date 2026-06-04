import { memStorage, volume } from '@justfiles/fs'
import { buildSync } from 'esbuild'
import { expect, test } from 'vitest'
import { appBundleFromMemory } from './app.ts'
import { type GetSandbox, type HostCapabilityInvoke, kernel } from './kernel.ts'
import chainSource from './test-bundle/chain.ts?raw'
import coreSource from './test-bundle/core.ts?raw'

// Part B end-to-end: a pure-core edge emits a Command, the KERNEL runs it
// (attaching trusted scopes), and the typed Result re-enters the reducer as a
// `__cmd/<to>` message. `settled` waits for the whole emit→run→result cascade.

const compile = (source: string) =>
	buildSync({
		stdin: {
			contents: source,
			loader: 'ts',
			resolveDir: new URL('./test-bundle', import.meta.url).pathname
		},
		bundle: true,
		write: false,
		format: 'esm'
	}).outputFiles[0].text

const coreCode = compile(coreSource)
const chainCode = compile(chainSource)

const sandbox: GetSandbox = async ({ code }) => {
	// Buffer (not btoa) so non-Latin1 bytes in the bundle survive the data URL.
	const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
	return {
		run: (message, ctx) => mod.app.dispatch(message, ctx),
		actions: async () => mod.app.actions ?? {},
		capabilities: async () => mod.app.capabilities ?? {},
		runProcedure: (name, params, handle) => mod.app.runProcedure(name, params, handle)
	}
}

async function start(invoke: HostCapabilityInvoke, code = coreCode) {
	const k = kernel({ fs: volume(memStorage()), sandbox, clock: {}, capabilityInvoke: invoke })
	const appId = await k.install(
		appBundleFromMemory({ id: 'com.example.app', name: 'App', app: code })
	)
	return { k, appId }
}

test('a command runs in the kernel and its result re-enters the reducer', async () => {
	const scan: HostCapabilityInvoke = async (req) => {
		if (req.capability === 'volume' && req.method === 'scan')
			return [
				{ path: '/a.txt', type: 'file' },
				{ path: '/dir', type: 'dir' },
				{ path: '/b.txt', type: 'file' }
			]
		throw new Error(`unexpected ${req.capability}.${req.method}`)
	}
	const { k, appId } = await start(scan)

	const seqs: number[] = []
	k.subscribe((e) => {
		if (e.type === 'app.update' && e.appId === appId) seqs.push(e.seq)
	})

	void k.dispatch(appId, { type: 'refresh', params: {} })
	// `refresh` commits at seq 1 and emits `scan`; `settled(…, 1)` must wait past
	// it for the off-queue command's `filesLoaded` result to land at seq 2.
	expect(await k.settled(appId, 1)).toEqual({
		files: [{ path: '/a.txt' }, { path: '/b.txt' }],
		loading: false,
		error: null
	})
	expect(seqs).toEqual([1, 2])
})

test('the kernel attaches appId and declared scopes to a command capability call', async () => {
	const calls: Array<{
		appId: string
		capability: string
		method: string
		scopes: readonly string[]
	}> = []
	const scan: HostCapabilityInvoke = async (req) => {
		calls.push({
			appId: req.appId,
			capability: req.capability,
			method: req.method,
			scopes: req.scopes
		})
		return []
	}
	const { k, appId } = await start(scan)

	void k.dispatch(appId, { type: 'refresh', params: {} })
	await k.settled(appId, 1)

	// core.ts declares `volume({ scopes: ['system'] })`; the kernel attaches that
	// — not anything the isolate forwards — plus the appId.
	expect(calls).toEqual([
		{ appId: 'com.example.app', capability: 'volume', method: 'scan', scopes: ['system'] }
	])
})

test('a failed command routes an err Result the reducer folds into state', async () => {
	const scan: HostCapabilityInvoke = async () => {
		throw new Error('denied')
	}
	const { k, appId } = await start(scan)

	void k.dispatch(appId, { type: 'refresh', params: {} })
	expect(await k.settled(appId, 1)).toEqual({ files: [], loading: false, error: 'denied' })
})

test('settled waits out a multi-step command cascade', async () => {
	// Echo `run`: start(1) → stepped(value 1) emits run(2) → finished(value 2).
	const echo: HostCapabilityInvoke = async (req) => req.input
	const { k, appId } = await start(echo, chainCode)

	const seqs: number[] = []
	k.subscribe((e) => {
		if (e.type === 'app.update' && e.appId === appId) seqs.push(e.seq)
	})

	void k.dispatch(appId, { type: 'start', params: { n: 1 } })
	// `start` is seq 1; settled must stay until the 2-deep chain quiesces at seq 3.
	expect(await k.settled(appId, 1)).toEqual({ value: 2, done: true })
	expect(seqs).toEqual([1, 2, 3])
})
