import { chroot, type Volume, volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { buildSync } from 'esbuild'
import { expect, test } from 'vitest'
import { type AppBundle, appBundleFromMemory } from './app.ts'
import { createAppController } from './app-controller.ts'
import { type Capabilities, type GetSandbox, kernel } from './kernel.ts'
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
		// Buffer (not btoa) so non-Latin1 bytes in the bundle survive the data URL.
		const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
		const app = mod.app
		if (typeof app !== 'object') {
			throw new Error(`app module must export an object named "app"`)
		}

		return {
			run: async (action, ctx) => await app.dispatch(action, ctx),
			initialState: async () => app.initialState,
			actions: async () => app.actions ?? {},
			capabilities: async () => app.capabilities ?? {},
			runProcedure: (name, params, handle) => app.runProcedure(name, params, handle)
		}
	}
}

// The host capability executor is now owned by the kernel, not the sandbox.
// The kernel attaches the app's declared scopes + appId before each call.
function hostInvoke(fs: Volume): Capabilities['invoke'] {
	return async (req) => {
		if (req.capability === 'test' && req.method === 'echo') return req.args[0]
		if (req.capability === 'volume' && req.method === 'writeFile') {
			const root = `/applications/${req.appId}/data/files`
			const [path, data] = req.args as [string, Uint8Array]
			await fs.mkdir(root, { recursive: true })
			await chroot(fs, root).writeFile(path, data)
			return undefined
		}
		throw new Error('missing capability')
	}
}

// Wrap an invoke into the seam; these tests exercise only the invoke arm, so the
// subscribe arm is an inert stub.
const caps = (invoke: Capabilities['invoke']): Capabilities => ({
	invoke,
	subscribe: async () => () => {}
})

const clock = {}

function testKernel() {
	const fs = volume(memStore())
	return kernel({ fs, sandbox: sandboxFor(), clock, capabilities: caps(hostInvoke(fs)) })
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
	const fs = volume(memStore())
	const k = kernel({ fs, sandbox: sandboxFor(), clock, capabilities: caps(hostInvoke(fs)) })
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
	expect(await k.state(appId)).toEqual({ count: 0 })

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

test('disposed kernel surfaces reset and a fresh kernel cannot serve or recreate cached state', async () => {
	const fs = volume(memStore())
	const app = appBundleFromMemory({ id: 'com.example.app', name: 'App', app: code })
	const first = kernel({ fs, sandbox: sandboxFor(), clock, capabilities: caps(hostInvoke(fs)) })
	const appId = await first.install(app)
	await first.dispatch(appId, { type: 'increment', params: { amount: 5 }, actor: 'agent' })
	expect(await first.state(appId)).toEqual({ count: 5 })

	first.dispose()
	await fs.rm(`/state/${appId}.json`)
	expect(() => first.dispatch(appId, { type: 'increment', params: { amount: 1 } })).toThrow(
		'Runtime reset while the app was running. Try again.'
	)

	const second = kernel({ fs, sandbox: sandboxFor(), clock, capabilities: caps(hostInvoke(fs)) })
	expect(await second.state(appId)).toEqual({ count: 0 })
	expect(await fs.exists(`/state/${appId}.json`)).toBe(false)
})

test('kernel attaches appId and the app-declared scopes to capability calls', async () => {
	// The trust boundary moved into the kernel: the host executor receives the
	// appId and the scopes the app DECLARED (volume → ['app'], test → []), read
	// from the bundle — never whatever the isolate forwards.
	const fs = volume(memStore())
	const calls: Array<{ appId: string; capability: string; scopes: readonly string[] }> = []
	const k = kernel({
		fs,
		sandbox: sandboxFor(),
		clock,
		capabilities: caps(async (req) => {
			calls.push({ appId: req.appId, capability: req.capability, scopes: req.scopes })
			return req.capability === 'test' ? req.args[0] : undefined
		})
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
	const fs = volume(memStore())
	const k = kernel({ fs, sandbox: sandboxFor(), clock, capabilities: caps(hostInvoke(fs)) })
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
	const fs = volume(memStore())
	const k = kernel({ fs, sandbox: sandboxFor(), clock, capabilities: caps(hostInvoke(fs)) })
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

test('an action that leaves state unchanged does not touch the state file', async () => {
	// Apps fold ambient signals (a volume watch, a re-scan) through the reducer, and
	// many of those land on the state they already had. That must be a no-op all the
	// way down: no write, no new version. Otherwise every idle signal becomes a
	// versioned write that sync hands to the other replica, whose apps wake on it in
	// turn — and the pair never settles.
	const store = memStore()
	const fs = volume(store)
	const k = kernel({ fs, sandbox: sandboxFor(), clock, capabilities: caps(hostInvoke(fs)) })
	const appId = await k.install(
		appBundleFromMemory({ id: 'com.example.app', name: 'App', app: code })
	)

	await k.dispatch(appId, { type: 'increment', params: { amount: 5 }, actor: 'agent' })
	// Where a peer's pull would resume: what "nothing to carry" has to mean.
	const quiet = (await store.since()).next

	const updates: unknown[] = []
	k.subscribe((e) => {
		if (e.type === 'app.update' && e.appId === appId) updates.push(e.state)
	})

	// A reducer edge that returns the state it was given (+0 is still a fresh object).
	expect(
		await k.dispatch(appId, { type: 'increment', params: { amount: 0 }, actor: 'agent' })
	).toEqual({ count: 5 })

	// Nothing was written, so there is nothing for sync to carry.
	expect((await store.since(quiet)).nodes).toEqual([])
	expect(JSON.parse(new TextDecoder().decode(await fs.readFile(`/state/${appId}.json`)))).toEqual({
		count: 5
	})

	// A real change still lands, from the same starting point.
	expect(
		await k.dispatch(appId, { type: 'increment', params: { amount: 1 }, actor: 'agent' })
	).toEqual({ count: 6 })
	expect((await store.since(quiet)).nodes).toHaveLength(1)
	expect(await k.state(appId)).toEqual({ count: 6 })
	expect(updates).toEqual([{ count: 6 }])
})

test('settled rejects when the version can never be reached', async () => {
	const fs = volume(memStore())
	const k = kernel({ fs, sandbox: sandboxFor(), clock, capabilities: caps(hostInvoke(fs)) })
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
	const fs = volume(memStore())
	const k = kernel({ fs, sandbox: sandboxFor(), clock, capabilities: caps(hostInvoke(fs)) })
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
	const fs = volume(memStore())
	const k = kernel({ fs, sandbox: sandboxFor(), clock, capabilities: caps(hostInvoke(fs)) })
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

test('install/uninstall emit catalog events; hidden ids stay off the catalog surface', async () => {
	const k = testKernel()
	const events: string[] = []
	k.subscribe((e) => {
		if (e.type === 'app.installed' || e.type === 'app.uninstalled')
			events.push(`${e.type}:${e.appId}`)
	})

	await k.install(appBundleFromMemory({ id: 'com.example.app', name: 'App', app: code }))
	// A hidden id (leading dot) installs and stays addressable by exact id, but is
	// omitted from `list()` and raises no lifecycle event — like a live preview.
	await k.install(appBundleFromMemory({ id: '.preview.demo', name: 'Preview', app: code }))

	expect((await k.list()).map((m) => m.id)).toEqual(['com.example.app'])
	expect((await k.app('.preview.demo')).manifest.id).toBe('.preview.demo')

	await k.uninstall('com.example.app')
	await k.uninstall('.preview.demo')

	// Only the visible app produced events; the hidden one never does.
	expect(events).toEqual(['app.installed:com.example.app', 'app.uninstalled:com.example.app'])
})

test('reload re-hydrates state written outside the kernel (a synced-down agent edit)', async () => {
	// frieren's browser kernel and the server kernel share a volume via sync: the
	// agent edits on the server, and the write lands in THIS kernel's fs as a
	// REMOTE_SOURCE write it never authored. The state cache assumes the kernel is
	// the sole writer, so `state()` would serve the stale pre-sync value forever —
	// `reload` is the seam the host calls on that remote write.
	const fs = volume(memStore())
	const k = kernel({ fs, sandbox: sandboxFor(), clock, capabilities: caps(hostInvoke(fs)) })
	const appId = await k.install(
		appBundleFromMemory({ id: 'com.example.app', name: 'App', app: code })
	)

	await k.dispatch(appId, { type: 'increment', params: { amount: 5 }, actor: 'agent' })
	expect(await k.state(appId)).toEqual({ count: 5 }) // cached in-memory

	// Simulate the sync layer applying the agent's server-side edit to /state.
	await fs.writeFile(
		`/state/${appId}.json`,
		new TextEncoder().encode(JSON.stringify({ count: 42 }))
	)
	// Without a reload the kernel still serves the stale cache — this WAS the bug
	// (the open GUI, which reads state(), kept showing the pre-edit value).
	expect(await k.state(appId)).toEqual({ count: 5 })

	await k.reload(appId)
	expect(await k.state(appId)).toEqual({ count: 42 }) // now reflects the synced file

	// The reloaded value is authoritative for the next dispatch — no stale clobber.
	expect(
		await k.dispatch(appId, { type: 'increment', params: { amount: 1 }, actor: 'agent' })
	).toEqual({ count: 43 })
})

test('app controller reloads state written outside the server kernel', async () => {
	const fs = volume(memStore())
	const k = kernel({ fs, sandbox: sandboxFor(), clock, capabilities: caps(hostInvoke(fs)) })
	const appId = await k.install(
		appBundleFromMemory({ id: 'com.example.app', name: 'App', app: code })
	)
	const controller = createAppController(k, {
		windows: { open: () => {}, close: () => {} }
	})

	await k.dispatch(appId, { type: 'increment', params: { amount: 5 }, actor: 'agent' })
	await fs.writeFile(
		`/state/${appId}.json`,
		new TextEncoder().encode(JSON.stringify({ count: 42 }))
	)

	expect(await controller.state(appId)).toEqual({ count: 42 })
	expect(await controller.run(appId, 'increment', { amount: 1 })).toEqual({ count: 43 })
})
