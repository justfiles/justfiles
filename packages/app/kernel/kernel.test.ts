import { memStorage, volume } from '@justfiles/fs'
import { buildSync } from 'esbuild'
import { expect, test } from 'vitest'
import { appBundleFromMemory } from './app'
import { type GetSandbox, kernel } from './kernel'
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

const sandbox: GetSandbox = async function (code: string) {
	const mod = await import(`data:text/javascript;base64,${btoa(code)}`)
	const app = mod.app
	if (typeof app !== 'object') {
		throw new Error(`app module must export an object named "app"`)
	}

	return {
		run: async (action, ctx) => await app.dispatch(action, ctx)
	}
}

const clock = {}

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

	// Framework-owned validation rejects bad params before the handler.
	await expect(
		k.dispatch(appId, { type: 'increment', params: { amount: 'nope' }, actor: 'agent' })
	).rejects.toThrow(/invalid params for increment/)
})
