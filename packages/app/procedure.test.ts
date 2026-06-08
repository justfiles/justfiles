import { memStorage, volume } from '@justfiles/fs'
import { buildSync } from 'esbuild'
import { expect, test } from 'vitest'
import { appBundleFromMemory } from './app.ts'
import { type Capabilities, type GetSandbox, kernel } from './kernel.ts'
import procedureSource from './test-bundle/procedure.ts?raw'

// Part C end-to-end: procedures run OUTSIDE the dispatch queue, drive the
// reducer through the handle (dispatch/settled), read capabilities
// (kernel-mediated, scope-checked), and return a value to the caller.

const code = buildSync({
	stdin: {
		contents: procedureSource,
		loader: 'ts',
		resolveDir: new URL('./test-bundle', import.meta.url).pathname
	},
	bundle: true,
	write: false,
	format: 'esm'
}).outputFiles[0].text

const sandbox: GetSandbox = async ({ code }) => {
	const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
	return {
		run: (message, ctx) => mod.app.dispatch(message, ctx),
		initialState: async () => mod.app.initialState,
		actions: async () => mod.app.actions ?? {},
		capabilities: async () => mod.app.capabilities ?? {},
		runProcedure: (name, params, handle) => mod.app.runProcedure(name, params, handle)
	}
}

async function start(invoke: Capabilities['invoke']) {
	const k = kernel({
		fs: volume(memStorage()),
		sandbox,
		clock: {},
		capabilities: { invoke, subscribe: async () => () => {} }
	})
	const appId = await k.install(
		appBundleFromMemory({ id: 'com.example.app', name: 'App', app: code })
	)
	return { k, appId }
}

const files: Capabilities['invoke'] = async (req) => {
	if (req.capability === 'volume' && req.method === 'scan')
		return [
			{ path: '/a.txt', type: 'file' },
			{ path: '/b.txt', type: 'file' }
		]
	if (req.capability === 'volume' && req.method === 'readFile')
		return new TextEncoder().encode('hello')
	throw new Error(`unexpected ${req.capability}.${req.method}`)
}

test('a read procedure returns a capability value to the caller, not into state', async () => {
	const { k, appId } = await start(files)

	const updates: unknown[] = []
	k.subscribe((e) => {
		if (e.type === 'app.update' && e.appId === appId) updates.push(e.state)
	})

	expect(await k.dispatch(appId, { type: 'readFile', params: { path: '/a.txt' } })).toBe('hello')
	// A read procedure never persists — no state push, state stays at init.
	expect(updates).toEqual([])
	expect(await k.state(appId)).toEqual({ files: [], loading: false, error: null })
})

test('a procedure drives the reducer (dispatch + settled) and reports by value', async () => {
	const { k, appId } = await start(files)

	// refreshAndCount dispatches `refresh` (emits a scan command), waits for the
	// whole cascade to settle, then returns the converged file count.
	expect(await k.dispatch(appId, { type: 'refreshAndCount', params: {} })).toEqual({ count: 2 })
	expect(await k.state(appId)).toEqual({
		files: [{ path: '/a.txt' }, { path: '/b.txt' }],
		loading: false,
		error: null
	})
})

test('the kernel attaches declared scopes to a procedure read', async () => {
	const calls: Array<{
		appId: string
		capability: string
		method: string
		scopes: readonly string[]
	}> = []
	const { k, appId } = await start(async (req) => {
		calls.push({
			appId: req.appId,
			capability: req.capability,
			method: req.method,
			scopes: req.scopes
		})
		return new TextEncoder().encode('x')
	})

	await k.dispatch(appId, { type: 'readFile', params: { path: '/a.txt' } })
	expect(calls).toEqual([
		{ appId: 'com.example.app', capability: 'volume', method: 'readFile', scopes: ['system'] }
	])
})

test("a 'gui' procedure is hidden from the agent's action list but still callable", async () => {
	const { k, appId } = await start(files)

	const actions = await k.actions(appId)
	expect(actions.fileCount).toBeUndefined()
	expect(actions.refreshAndCount).toMatchObject({ kind: 'procedure' })
	// Hidden from the list, but the GUI client can still call it.
	expect(await k.dispatch(appId, { type: 'fileCount', params: {} })).toBe(0)
})

test('the default: a plain agent dispatch resolves with the settled state', async () => {
	const { k, appId } = await start(files)

	// `refresh` is a command-emitting edge: its immediate result is the
	// loading:true frame, but an agent dispatch waits for the scan to settle.
	expect(await k.dispatch(appId, { type: 'refresh', params: {}, actor: 'agent' })).toEqual({
		files: [{ path: '/a.txt' }, { path: '/b.txt' }],
		loading: false,
		error: null
	})
})
