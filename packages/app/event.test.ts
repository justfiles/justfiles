import { memStorage, volume } from '@justfiles/fs'
import { buildSync } from 'esbuild'
import { expect, test } from 'vitest'
import { appBundleFromMemory } from './app.ts'
import { type GetSandbox, kernel } from './kernel.ts'
import source from './test-bundle/event.ts?raw'

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

const sandbox: GetSandbox = async ({ code }) => {
	const mod = await import(`data:text/javascript;base64,${btoa(code)}`)
	return {
		run: (action, ctx) => mod.app.dispatch(action, ctx),
		actions: async () => mod.app.actions ?? {}
	}
}

const clock = {}

test('kernel.emit fans events to apps declaring matching on-handlers', async () => {
	const k = kernel({ fs: volume(memStorage()), sandbox, clock })
	const appId = await k.install(
		appBundleFromMemory({ id: 'com.example.ticker', name: 'Ticker', app: code })
	)

	const updates: Array<{ count: number; lastReason: string | null }> = []
	k.subscribe((e) => {
		if (e.type === 'app.update' && e.appId === appId)
			updates.push(e.state as { count: number; lastReason: string | null })
	})

	await k.emit('ticker.tick', { delta: 3 })
	await k.emit('ticker.tick', { delta: 4 })
	await k.emit('ticker.reset', { reason: 'manual' })

	expect(await k.state(appId)).toEqual({ count: 0, lastReason: 'manual' })
	expect(updates).toEqual([
		{ count: 3, lastReason: null },
		{ count: 7, lastReason: null },
		{ count: 0, lastReason: 'manual' }
	])
})

test('event handlers are not exposed to the public action list', async () => {
	const k = kernel({ fs: volume(memStorage()), sandbox, clock })
	const appId = await k.install(
		appBundleFromMemory({ id: 'com.example.ticker', name: 'Ticker', app: code })
	)

	const meta = await k.actions(appId)
	expect(Object.keys(meta)).toEqual(['bump'])
})

test('emit ignores channels nobody subscribed to', async () => {
	const k = kernel({ fs: volume(memStorage()), sandbox, clock })
	await k.install(appBundleFromMemory({ id: 'com.example.ticker', name: 'Ticker', app: code }))
	await expect(k.emit('mystery.channel', { x: 1 })).resolves.toBeUndefined()
})

test('emit fans to multiple subscribers and survives one app erroring', async () => {
	const k = kernel({ fs: volume(memStorage()), sandbox, clock })
	const a = await k.install(
		appBundleFromMemory({ id: 'com.example.ticker.a', name: 'A', app: code })
	)
	const b = await k.install(
		appBundleFromMemory({ id: 'com.example.ticker.b', name: 'B', app: code })
	)

	await k.emit('ticker.tick', { delta: 5 })

	expect(await k.state(a)).toMatchObject({ count: 5 })
	expect(await k.state(b)).toMatchObject({ count: 5 })
})

test('uninstall removes the app from the subscription index', async () => {
	const k = kernel({ fs: volume(memStorage()), sandbox, clock })
	const appId = await k.install(
		appBundleFromMemory({ id: 'com.example.ticker', name: 'Ticker', app: code })
	)

	await k.emit('ticker.tick', { delta: 2 })
	expect(await k.state(appId)).toMatchObject({ count: 2 })

	await k.uninstall(appId)
	// Re-emit after uninstall: nothing to dispatch to. No app, no error.
	await expect(k.emit('ticker.tick', { delta: 100 })).resolves.toBeUndefined()
})
