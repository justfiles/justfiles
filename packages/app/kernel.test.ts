import { memStorage, volume } from '@justfiles/fs'
import { buildSync } from 'esbuild'
import { expect, test } from 'vitest'
import { type AppBundle, appBundleFromMemory } from './app.ts'
import { type GetSandbox, kernel } from './kernel.ts'
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

const sandbox: GetSandbox = async function ({ code }) {
	const mod = await import(`data:text/javascript;base64,${btoa(code)}`)
	const app = mod.app
	if (typeof app !== 'object') {
		throw new Error(`app module must export an object named "app"`)
	}

	return {
		run: async (action, ctx) =>
			await app.dispatch(action, {
				...ctx,
				capabilityInvoke: async (req) => {
					if (req.capability === 'test' && req.method === 'echo') return req.input
					throw new Error('missing capability')
				}
			}),
		actions: async () => app.actions ?? {}
	}
}

const clock = {}

function testKernel() {
	return kernel({ fs: volume(memStorage()), sandbox, clock })
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
	const k = kernel({ fs, sandbox, clock })
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
