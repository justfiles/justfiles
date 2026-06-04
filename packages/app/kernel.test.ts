import { chroot, memStorage, type Volume, volume } from '@justfiles/fs'
import { buildSync } from 'esbuild'
import { expect, test } from 'vitest'
import { type AppBundle, appBundleFromMemory } from './app.ts'
import { type GetSandbox, type HostCapabilityInvoke, kernel } from './kernel.ts'
import source from './test-bundle/app.ts?raw'

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
const code = compile(source)

function sandboxFor(): GetSandbox {
	return async ({ code }) => {
		const mod = await import(`data:text/javascript;base64,${btoa(code)}`)
		const app = mod.app
		if (typeof app !== 'object') {
			throw new Error(`app module must export an object named "app"`)
		}

		return {
			run: async (action, ctx) => await app.dispatch(action, ctx),
			actions: async () => app.actions ?? {},
			capabilities: async () => app.capabilities ?? {},
			runProcedure: (name, params, handle) => app.runProcedure(name, params, handle)
		}
	}
}

// The host capability executor is now owned by the kernel, not the sandbox.
// The kernel attaches the app's declared scopes + appId before each call.
function hostInvoke(fs: Volume): HostCapabilityInvoke {
	return async (req) => {
		if (req.capability === 'test' && req.method === 'echo') return req.input
		if (req.capability === 'volume' && req.method === 'writeFile') {
			const root = `/applications/${req.appId}/data/files`
			const input = req.input as { path: string; data: Uint8Array }
			await fs.mkdir(root, { recursive: true })
			await chroot(fs, root).writeFile(input.path, input.data)
			return undefined
		}
		throw new Error('missing capability')
	}
}

const clock = {}

function testKernel() {
	const fs = volume(memStorage())
	return kernel({ fs, sandbox: sandboxFor(), clock, capabilityInvoke: hostInvoke(fs) })
}

function bundle(manifest: AppBundle['manifest'], files: Record<string, string>): AppBundle {
	return {
		manifest,
		async *list() {
			yield* Object.keys(files)
		},
		async read(path) {
			const file = files[path]
			if (file == null) throw new Error(`file not found: ${path}`)
			return new TextEncoder().encode(file)
		}
	}
}

test('smoke test kernel', async () => {
	const fs = volume(memStorage())
	const k = kernel({ fs, sandbox: sandboxFor(), clock, capabilityInvoke: hostInvoke(fs) })
	const app = appBundleFromMemory({
		id: 'com.example.app',
		name: 'App',
		app: code
	})
	const appId = await k.install(app)

	expect(appId).toBe('com.example.app')
	expect(await fs.exists('/applications/com.example.app/manifest.json')).toBe(true)
	expect(await fs.exists('/applications/index.json')).toBe(false)
	expect(await k.actions(appId)).toMatchObject({
		increment: { schemaHint: { amount: 'number' } }
	})

	let result = await k.dispatch(appId, {
		type: 'increment',
		params: { amount: 5 },
		actor: 'agent'
	})

	expect(result).toEqual({ count: 5 })

	result = await k.dispatch(appId, {
		type: 'increment',
		params: { amount: 2 },
		actor: 'agent'
	})

	expect(result).toEqual({ count: 7 })

	expect(await fs.exists('/state/com.example.app.json')).toBe(true)
	expect(await fs.exists('/applications/com.example.app/data/state.json')).toBe(false)
	expect(
		JSON.parse(new TextDecoder().decode(await fs.readFile('/state/com.example.app.json')))
	).toEqual({ count: 7 })

	await k.dispatch(appId, {
		type: 'write',
		params: { text: 'hello' },
		actor: 'agent'
	})

	expect(await fs.exists('/note.txt')).toBe(false)
	expect(await fs.exists('/applications/com.example.app/data/files/note.txt')).toBe(true)

	result = await k.dispatch(appId, {
		type: 'ask',
		params: { text: 'capability' },
		actor: 'agent'
	})

	expect(result).toEqual({ count: 'capability'.length })

	// Framework-owned validation rejects bad params before the handler.
	await expect(
		k.dispatch(appId, { type: 'increment', params: { amount: 'nope' }, actor: 'agent' })
	).rejects.toThrow(/invalid params for increment/)
})

test('kernel attaches appId and the app-declared scopes to capability calls', async () => {
	// The trust boundary moved into the kernel: the host executor receives the
	// appId and the scopes the app DECLARED (volume → ['app'], test → []), read
	// from the bundle — never whatever the isolate forwards.
	const fs = volume(memStorage())
	const calls: Array<{ appId: string; capability: string; scopes: readonly string[] }> = []
	const k = kernel({
		fs,
		sandbox: sandboxFor(),
		clock,
		capabilityInvoke: async (req) => {
			calls.push({ appId: req.appId, capability: req.capability, scopes: req.scopes })
			return req.capability === 'test' ? req.input : undefined
		}
	})
	const appId = await k.install(
		appBundleFromMemory({ id: 'com.example.app', name: 'App', app: code })
	)

	await k.dispatch(appId, { type: 'write', params: { text: 'hi' }, actor: 'agent' })
	await k.dispatch(appId, { type: 'ask', params: { text: 'x' }, actor: 'agent' })

	expect(calls).toEqual([
		{ appId: 'com.example.app', capability: 'volume', scopes: ['app'] },
		{ appId: 'com.example.app', capability: 'test', scopes: [] }
	])
})

test('serializes concurrent dispatches — no lost update', async () => {
	const fs = volume(memStorage())
	const k = kernel({ fs, sandbox: sandboxFor(), clock, capabilityInvoke: hostInvoke(fs) })
	const appId = await k.install(
		appBundleFromMemory({ id: 'com.example.app', name: 'App', app: code })
	)

	// `increment` is a read-modify-write (count + amount). Fired concurrently
	// without per-app serialization, the dispatches interleave loadState →
	// run → saveState and clobber each other. The queue makes the final count
	// exact.
	const n = 25
	await Promise.all(
		Array.from({ length: n }, () =>
			k.dispatch(appId, { type: 'increment', params: { amount: 1 }, actor: 'agent' })
		)
	)

	expect(await k.state(appId)).toEqual({ count: n })
})

test('settled resolves with the converged state at a version', async () => {
	const fs = volume(memStorage())
	const k = kernel({ fs, sandbox: sandboxFor(), clock, capabilityInvoke: hostInvoke(fs) })
	const appId = await k.install(
		appBundleFromMemory({ id: 'com.example.app', name: 'App', app: code })
	)

	const seqs: number[] = []
	k.subscribe((e) => {
		if (e.type === 'app.update' && e.appId === appId) seqs.push(e.seq)
	})

	const n = 10
	// Fire without awaiting; settled drains the per-app queue, then returns the
	// converged state once the committed version has reached `n`.
	void Promise.all(
		Array.from({ length: n }, () =>
			k.dispatch(appId, { type: 'increment', params: { amount: 1 }, actor: 'agent' })
		)
	)

	expect(await k.settled(appId, n)).toEqual({ count: n })
	// seq rides on every app.update event, monotonic from 1.
	expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
})

test('settled rejects when the version can never be reached', async () => {
	const fs = volume(memStorage())
	const k = kernel({ fs, sandbox: sandboxFor(), clock, capabilityInvoke: hostInvoke(fs) })
	const appId = await k.install(
		appBundleFromMemory({ id: 'com.example.app', name: 'App', app: code })
	)

	await k.dispatch(appId, { type: 'increment', params: { amount: 1 }, actor: 'agent' })
	// Queue is idle at seq 1; nothing pending will ever reach seq 5.
	await expect(k.settled(appId, 5, { timeout: 100 })).rejects.toThrow(/never reached 5/)
})

test('install rejects invalid manifest entry path', async () => {
	const k = testKernel()
	await expect(
		k.install(
			bundle(async () => ({ id: 'com.example.app', name: 'App', app: '../app.js' }), {
				'app.js': code
			})
		)
	).rejects.toThrow(/invalid app bundle path/)
})

test('install rejects invalid listed file path', async () => {
	const k = testKernel()
	await expect(
		k.install(
			bundle(async () => ({ id: 'com.example.app', name: 'App', app: 'app.js' }), {
				'../evil.js': code
			})
		)
	).rejects.toThrow(/invalid app bundle path/)
})

test('uninstall removes bundle, state, and data', async () => {
	const fs = volume(memStorage())
	const k = kernel({ fs, sandbox: sandboxFor(), clock, capabilityInvoke: hostInvoke(fs) })
	const app = appBundleFromMemory({
		id: 'com.example.app',
		name: 'App',
		app: code
	})
	const appId = await k.install(app)

	await k.dispatch(appId, { type: 'increment', params: { amount: 1 }, actor: 'agent' })
	await k.dispatch(appId, { type: 'write', params: { text: 'hi' }, actor: 'agent' })

	expect(await fs.exists('/applications/com.example.app')).toBe(true)
	expect(await fs.exists('/state/com.example.app.json')).toBe(true)
	expect(await fs.exists('/applications/com.example.app/data/files/note.txt')).toBe(true)

	// Pretend the new-layout app-sandbox path also has bytes — uninstall must
	// nuke it even though the test harness currently writes under /applications.
	await fs.mkdir('/data/com.example.app', { recursive: true })
	await fs.writeFile('/data/com.example.app/scratch.txt', new TextEncoder().encode('x'))

	await k.uninstall(appId)

	expect(await fs.exists('/applications/com.example.app')).toBe(false)
	expect(await fs.exists('/state/com.example.app.json')).toBe(false)
	expect(await fs.exists('/data/com.example.app')).toBe(false)
})

test('install rejects missing app entry', async () => {
	const k = testKernel()
	await expect(
		k.install(
			bundle(async () => ({ id: 'com.example.app', name: 'App', app: 'app.js' }), {
				'other.js': code
			})
		)
	).rejects.toThrow(/missing app entry: app.js/)
})

test('failed reinstall preserves the existing app', async () => {
	const fs = volume(memStorage())
	const k = kernel({ fs, sandbox: sandboxFor(), clock, capabilityInvoke: hostInvoke(fs) })
	await k.install(appBundleFromMemory({ id: 'com.example.app', name: 'App', app: code }))

	await expect(
		k.install(
			bundle(async () => ({ id: 'com.example.app', name: 'App', app: 'app.js' }), {
				'other.js': code
			})
		)
	).rejects.toThrow(/missing app entry: app.js/)

	expect(await fs.exists('/applications/com.example.app/app.js')).toBe(true)
	expect((await k.list()).map((app) => app.id)).toEqual(['com.example.app'])
})
