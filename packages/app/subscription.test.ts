import { memStorage, volume } from '@justfiles/fs'
import { buildSync } from 'esbuild'
import { expect, test } from 'vitest'
import { appBundleFromMemory } from './app.ts'
import { type GetSandbox, type HostCapabilityStream, kernel } from './kernel.ts'
import source from './test-bundle/subscription.ts?raw'
import initSource from './test-bundle/subscription-init.ts?raw'

// Part D end-to-end: `subscriptions(state)` declares a stream, the kernel diffs
// the set on every commit (start / switch / stop), and each emitted event
// re-enters the reducer as a `__sub/<to>` message.

const compile = (src: string) =>
	buildSync({
		stdin: {
			contents: src,
			loader: 'ts',
			resolveDir: new URL('./test-bundle', import.meta.url).pathname
		},
		bundle: true,
		write: false,
		format: 'esm'
	}).outputFiles[0].text

const code = compile(source)
const initCode = compile(initSource)

const sandbox: GetSandbox = async ({ code }) => {
	const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
	return {
		run: (message, ctx) => mod.app.dispatch(message, ctx),
		actions: async () => mod.app.actions ?? {},
		capabilities: async () => mod.app.capabilities ?? {},
		runProcedure: (name, params, handle) => mod.app.runProcedure(name, params, handle),
		subscriptions: async (state) => mod.app.subscriptions?.(state) ?? []
	}
}

// A controllable host stream: every open is recorded with the input it was given
// and an `emit` the test drives by hand; the returned unsubscribe flips `stopped`.
type Opened = {
	capability: string
	method: string
	input: unknown
	scopes: readonly string[]
	emit: (event: unknown) => void
	stopped: boolean
}
function fakeStream() {
	const opened: Opened[] = []
	const stream: HostCapabilityStream = async (req, emit) => {
		const entry: Opened = { ...req, emit, stopped: false }
		opened.push(entry)
		return () => {
			entry.stopped = true
		}
	}
	const live = () => opened.filter((o) => !o.stopped)
	const pathOf = (o: Opened) => (o.input as { path: string }).path
	return { opened, stream, live, pathOf }
}

async function until(cond: () => boolean | Promise<boolean>, label: string): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (await cond()) return
		await new Promise((r) => setTimeout(r, 2))
	}
	throw new Error(`timeout: ${label}`)
}

async function start(stream: HostCapabilityStream) {
	const fs = volume(memStorage())
	const k = kernel({ fs, sandbox, clock: {}, capabilityStream: stream })
	const appId = await k.install(
		appBundleFromMemory({ id: 'com.example.watch', name: 'Watch', app: code })
	)
	return { fs, k, appId }
}

test('declaring a stream starts it and its events fold into state', async () => {
	const host = fakeStream()
	const { k, appId } = await start(host.stream)

	await k.dispatch(appId, { type: 'open', params: { path: '/a' } })
	await until(() => host.live().length === 1, 'stream /a started')
	expect(host.opened[0]).toMatchObject({
		capability: 'volume',
		method: 'watch',
		scopes: ['system']
	})
	expect(host.pathOf(host.opened[0])).toBe('/a')

	host.opened[0].emit({ source: 'remote' })
	host.opened[0].emit({})
	await until(async () => ((await k.state(appId)) as { events: number }).events === 2, 'two events')
	expect(await k.state(appId)).toEqual({ watching: '/a', events: 2, lastSource: null })
})

test('switching the watched path stops the old stream and starts the new', async () => {
	const host = fakeStream()
	const { k, appId } = await start(host.stream)

	await k.dispatch(appId, { type: 'open', params: { path: '/a' } })
	await until(() => host.live().length === 1, 'stream /a started')

	await k.dispatch(appId, { type: 'open', params: { path: '/b' } })
	await until(
		() => host.live().length === 1 && host.pathOf(host.live()[0]) === '/b',
		'switched to /b'
	)

	// The /a stream was torn down, /b is the only live one.
	expect(host.opened.map((o) => host.pathOf(o))).toEqual(['/a', '/b'])
	expect(host.opened[0].stopped).toBe(true)
	expect(host.opened[1].stopped).toBe(false)
})

test('a stopped or switched stream cannot deliver stale events', async () => {
	const host = fakeStream()
	const { k, appId } = await start(host.stream)

	await k.dispatch(appId, { type: 'open', params: { path: '/a' } })
	await until(() => host.live().length === 1, 'stream /a started')
	const aStream = host.opened[0]

	// Switch to /b: /a is torn down. A coalesced/late /a event (the host hasn't
	// fully drained) must NOT reduce into /b's state.
	await k.dispatch(appId, { type: 'open', params: { path: '/b' } })
	await until(() => host.live().length === 1 && host.pathOf(host.live()[0]) === '/b', 'switched')
	expect(aStream.stopped).toBe(true)
	aStream.emit({ source: 'late-a' })
	await new Promise((r) => setTimeout(r, 20))
	expect(await k.state(appId)).toEqual({ watching: '/b', events: 0, lastSource: null })

	// Same after close: a late event from the just-stopped /b stream is dropped.
	const bStream = host.live()[0]
	await k.dispatch(appId, { type: 'close', params: {} })
	await until(() => host.live().length === 0, 'stream stopped')
	bStream.emit({ source: 'late-b' })
	await new Promise((r) => setTimeout(r, 20))
	expect(await k.state(appId)).toEqual({ watching: null, events: 0, lastSource: null })
})

test('clearing the declared set stops the stream', async () => {
	const host = fakeStream()
	const { k, appId } = await start(host.stream)

	await k.dispatch(appId, { type: 'open', params: { path: '/a' } })
	await until(() => host.live().length === 1, 'stream started')

	await k.dispatch(appId, { type: 'close', params: {} })
	await until(() => host.live().length === 0, 'stream stopped')
	expect(host.opened[0].stopped).toBe(true)
})

test('an unchanged declared stream is kept across an unrelated commit', async () => {
	const host = fakeStream()
	const { k, appId } = await start(host.stream)

	await k.dispatch(appId, { type: 'open', params: { path: '/a' } })
	await until(() => host.live().length === 1, 'stream started')
	const first = host.opened[0]

	// Re-open the SAME path: same structural key → the stream must not churn.
	await k.dispatch(appId, { type: 'open', params: { path: '/a' } })
	await new Promise((r) => setTimeout(r, 20))
	expect(host.opened).toHaveLength(1)
	expect(first.stopped).toBe(false)
})

test('streams are rebuilt from persisted state on boot', async () => {
	const host1 = fakeStream()
	const { fs, k, appId } = await start(host1.stream)
	await k.dispatch(appId, { type: 'open', params: { path: '/a' } })
	await until(() => host1.live().length === 1, 'stream started')

	// New kernel over the SAME fs (a DO restart): in-memory streams are gone.
	const host2 = fakeStream()
	const k2 = kernel({ fs, sandbox, clock: {}, capabilityStream: host2.stream })
	expect(host2.opened).toHaveLength(0)

	// Touching state is the host's first boot interaction — it re-warms the set.
	expect(await k2.state(appId)).toEqual({ watching: '/a', events: 0, lastSource: null })
	await until(
		() => host2.live().length === 1 && host2.pathOf(host2.live()[0]) === '/a',
		'rehydrated'
	)
})

test('a cold kernel rehydrates streams on first actions() touch, not only state()', async () => {
	const host1 = fakeStream()
	const { fs, k, appId } = await start(host1.stream)
	await k.dispatch(appId, { type: 'open', params: { path: '/a' } })
	await until(() => host1.live().length === 1, 'stream started')

	// Restart: the agent's first touch is listing tools, never state().
	const host2 = fakeStream()
	const k2 = kernel({ fs, sandbox, clock: {}, capabilityStream: host2.stream })
	await k2.actions(appId)
	await until(
		() => host2.live().length === 1 && host2.pathOf(host2.live()[0]) === '/a',
		'rehydrated via actions()'
	)
})

test('install starts a stream the init state unconditionally declares', async () => {
	const host = fakeStream()
	const fs = volume(memStorage())
	const k = kernel({ fs, sandbox, clock: {}, capabilityStream: host.stream })
	await k.install(
		appBundleFromMemory({ id: 'com.example.initwatch', name: 'InitWatch', app: initCode })
	)
	// No state() snapshot, no dispatch — install alone warms the init stream.
	await until(
		() => host.live().length === 1 && host.pathOf(host.live()[0]) === '/fixed',
		'init stream started on install'
	)
})

test('no host stream wiring → no subscriptions, dispatch still works', async () => {
	const fs = volume(memStorage())
	const k = kernel({ fs, sandbox, clock: {} })
	const appId = await k.install(
		appBundleFromMemory({ id: 'com.example.watch', name: 'Watch', app: code })
	)
	await k.dispatch(appId, { type: 'open', params: { path: '/a' } })
	expect(await k.state(appId)).toEqual({ watching: '/a', events: 0, lastSource: null })
})
