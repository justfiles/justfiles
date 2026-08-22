import { expect, test } from 'vitest'
import type { Message, Subscription } from './app.ts'
import type { Declared } from './kernel.capability.ts'
import { type Subscriptions, subscriptionRuntime } from './kernel.subscription.ts'

// The subscription reconciler in isolation — no kernel, no sandbox. A controllable
// host stream (every open records its input and an `emit` the test drives by hand;
// its unsubscribe flips `stopped`) lets us pin the diff and the live/stale-event
// logic without booting the kernel.

const sub = (path: string, to = 'changed'): Subscription => ({
	capability: 'volume',
	method: 'watch',
	args: [{ path }],
	to
})

const flush = () => new Promise((r) => setTimeout(r, 5))
async function until(cond: () => boolean, label: string): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (cond()) return
		await new Promise((r) => setTimeout(r, 2))
	}
	throw new Error(`timeout: ${label}`)
}

type Opened = {
	appId: string
	capability: string
	method: string
	args: readonly unknown[]
	scopes: readonly string[]
	emit: (event: unknown) => void
	stopped: boolean
}
function fakeStream() {
	const opened: Opened[] = []
	const subscribe = async (
		req: Omit<Opened, 'emit' | 'stopped'>,
		emit: (event: unknown) => void
	) => {
		const entry: Opened = { ...req, emit, stopped: false }
		opened.push(entry)
		return () => {
			entry.stopped = true
		}
	}
	const live = () => opened.filter((o) => !o.stopped)
	const pathOf = (o: Opened) => (o.args[0] as { path: string }).path
	return { opened, subscribe, live, pathOf }
}

const declared: Record<string, Declared> = { volume: { id: 'volume', scopes: ['system'] } }

function make(over: { resolve?: SubDeps['resolve']; loadDesired?: SubDeps['loadDesired'] } = {}) {
	const host = fakeStream()
	const dispatched: Array<{ appId: string; message: Message }> = []
	const errors: Array<{ appId: string; error: string }> = []
	const runtime: Subscriptions = subscriptionRuntime({
		resolve: over.resolve ?? (async (_app, name) => declared[name]),
		subscribe: host.subscribe,
		dispatch: async (appId, message) => {
			dispatched.push({ appId, message })
			return undefined
		},
		enqueue: (_appId, task) => task(),
		loadDesired: over.loadDesired ?? (async () => []),
		onError: (appId, error) => errors.push({ appId, error })
	})
	return { runtime, host, dispatched, errors }
}
type SubDeps = Parameters<typeof subscriptionRuntime>[0]

test('reconcile starts a declared stream and its events re-enter via dispatch', async () => {
	const { runtime, host, dispatched } = make()
	runtime.reconcile('app', [sub('/a')])
	await until(() => host.live().length === 1, 'stream /a started')
	expect(host.opened[0]).toMatchObject({
		appId: 'app',
		capability: 'volume',
		method: 'watch',
		args: [{ path: '/a' }],
		scopes: ['system']
	})

	host.opened[0]?.emit({ x: 1 })
	await flush()
	expect(dispatched).toEqual([
		{
			appId: 'app',
			message: { type: '__sub/changed', params: { x: 1 }, actor: 'capability:volume' }
		}
	])
})

test('switching the input stops the old stream and starts the new', async () => {
	const { runtime, host } = make()
	runtime.reconcile('app', [sub('/a')])
	await until(() => host.live().length === 1, 'stream /a started')

	runtime.reconcile('app', [sub('/b')])
	await until(() => host.live().length === 1 && host.pathOf(host.live()[0]!) === '/b', 'switched')
	expect(host.opened.map(host.pathOf)).toEqual(['/a', '/b'])
	expect(host.opened[0]?.stopped).toBe(true)
})

test('a stopped/switched stream cannot deliver a stale event', async () => {
	const { runtime, host, dispatched } = make()
	runtime.reconcile('app', [sub('/a')])
	await until(() => host.live().length === 1, 'stream /a started')
	const a = host.opened[0]!

	runtime.reconcile('app', [sub('/b')])
	await until(() => host.live().length === 1 && host.pathOf(host.live()[0]!) === '/b', 'switched')
	expect(a.stopped).toBe(true)

	// A coalesced/late /a event must NOT reduce after the switch.
	a.emit({ from: 'late-a' })
	await flush()
	expect(dispatched).toEqual([])
})

test('an unchanged declared stream is kept across a reconcile (no churn)', async () => {
	const { runtime, host } = make()
	runtime.reconcile('app', [sub('/a')])
	await until(() => host.live().length === 1, 'stream started')
	const first = host.opened[0]!

	runtime.reconcile('app', [sub('/a')]) // same structural key
	await flush()
	expect(host.opened).toHaveLength(1)
	expect(first.stopped).toBe(false)
})

test('clearing the declared set stops the stream', async () => {
	const { runtime, host } = make()
	runtime.reconcile('app', [sub('/a')])
	await until(() => host.live().length === 1, 'stream started')

	runtime.reconcile('app', [])
	expect(host.opened[0]?.stopped).toBe(true)
})

test('stop tears down every stream for an app', async () => {
	const { runtime, host } = make()
	expect(runtime.stop('cold')).toBe(false)
	runtime.reconcile('app', [sub('/a', 'a'), sub('/b', 'b')])
	await until(() => host.live().length === 2, 'both started')

	expect(runtime.stop('app')).toBe(true)
	expect(host.opened.every((o) => o.stopped)).toBe(true)
})

test('ensure warms the streams persisted state declares', async () => {
	const { runtime, host } = make({ loadDesired: async () => [sub('/fixed')] })
	runtime.ensure('app')
	await until(() => host.live().length === 1 && host.pathOf(host.live()[0]!) === '/fixed', 'warmed')

	// Idempotent — a second ensure does not re-warm.
	runtime.ensure('app')
	await flush()
	expect(host.opened).toHaveLength(1)
})

test('an undeclared capability surfaces via onError', async () => {
	const { runtime, errors } = make({ resolve: async () => undefined })
	runtime.reconcile('app', [sub('/a')])
	await until(() => errors.length === 1, 'error surfaced')
	expect(errors[0]?.error).toContain('undeclared capability: volume')
})

test('without a host stream opener reconcile and ensure are inert', async () => {
	const dispatched: Array<{ appId: string; message: Message }> = []
	const errors: string[] = []
	const runtime = subscriptionRuntime({
		resolve: async (_app, name) => declared[name],
		subscribe: undefined,
		dispatch: async (appId, message) => {
			dispatched.push({ appId, message })
			return undefined
		},
		enqueue: (_appId, task) => task(),
		loadDesired: async () => [sub('/a')],
		onError: (_appId, error) => errors.push(error)
	})
	runtime.reconcile('app', [sub('/a')])
	runtime.ensure('app')
	await flush()
	expect(dispatched).toEqual([])
	expect(errors).toEqual([])
})

// A gated `dispatch`: the test decides when a reduce completes, which is what makes
// "outstanding" observable. Everything else mirrors `make()`.
function gated(subscribe: SubDeps['subscribe']) {
	const params: unknown[] = []
	let release!: () => void
	const gate = new Promise<void>((r) => {
		release = r
	})
	const runtime = subscriptionRuntime({
		resolve: async (_appId, name) => declared[name],
		subscribe,
		dispatch: async (_appId, message) => {
			params.push(message.params)
			await gate
			return undefined
		},
		enqueue: (_appId, task) => task(),
		loadDesired: async () => [],
		onError: () => {}
	})
	return { runtime, params, release: () => release() }
}

test('a coalescing stream folds a burst into the in-flight event plus one trailing', async () => {
	const host = fakeStream()
	const { runtime, params, release } = gated(host.subscribe)
	runtime.reconcile('app', [{ ...sub('/'), coalesce: true }])
	await until(() => host.live().length === 1, 'stream started')
	const stream = host.opened[0]

	stream?.emit(1)
	await flush()
	expect(params).toEqual([1]) // one reduce outstanding

	// The burst a bulk fs operation produces. Each of these used to become its own
	// queued dispatch — a bundle read, a state clone through the isolate, maybe a
	// commit — ahead of everything else chained on this app's queue.
	for (let i = 2; i <= 50; i++) stream?.emit(i)
	await flush()
	expect(params).toEqual([1])

	// Let the outstanding reduce land: ONE trailing dispatch, carrying the NEWEST
	// payload (a wake says "re-read", so the newest supersedes the rest).
	release()
	await flush()
	expect(params).toEqual([1, 50])
})

test('a stream that does not opt in keeps every event', async () => {
	const host = fakeStream()
	const { runtime, params } = gated(host.subscribe)
	runtime.reconcile('app', [sub('/')])
	await until(() => host.live().length === 1, 'stream started')

	// No `coalesce`, so nothing may be dropped: a stream whose events each carry
	// information (a token stream) must reduce all of them, in order.
	for (let i = 1; i <= 5; i++) host.opened[0]?.emit(i)
	await flush()
	expect(params).toEqual([1, 2, 3, 4, 5])
})

test('a coalescing stream stopped mid-burst drops its trailing event', async () => {
	const host = fakeStream()
	const { runtime, params, release } = gated(host.subscribe)
	runtime.reconcile('app', [{ ...sub('/'), coalesce: true }])
	await until(() => host.live().length === 1, 'stream started')
	const stream = host.opened[0]

	stream?.emit(1)
	await flush()
	stream?.emit(2)

	// Uninstall/reinstall while a reduce is outstanding: the folded trailing event
	// belongs to a stream that no longer exists, so it must not reduce into the
	// state that replaced it.
	runtime.stop('app')
	release()
	await flush()
	expect(params).toEqual([1])
})

test('flipping a stream’s coalescing mode restarts it, so the new mode takes effect', async () => {
	const host = fakeStream()
	const { runtime, params } = gated(host.subscribe)

	// Declared coalescing: a burst folds into the in-flight event.
	runtime.reconcile('app', [{ ...sub('/'), coalesce: true }])
	await until(() => host.live().length === 1, 'coalescing stream started')
	for (let i = 1; i <= 5; i++) host.opened[0]?.emit(i)
	await flush()
	expect(params).toEqual([1])

	// The SAME capability/method/args/to, coalescing declared off. `startStream` captures
	// the descriptor it was started with, so this only works if the mode is part of the
	// diff key: otherwise the reconciler calls it unchanged and keeps folding events the
	// app just asked it to stop folding.
	runtime.reconcile('app', [sub('/')])
	await until(() => host.opened.length === 2 && host.live().length === 1, 'restarted uncoalesced')
	expect(host.opened[0]?.stopped).toBe(true)
	for (let i = 6; i <= 10; i++) host.opened[1]?.emit(i)
	await flush()
	expect(params).toEqual([1, 6, 7, 8, 9, 10])

	// And back: an unbounded stream must not stay unbounded once coalescing is declared.
	runtime.reconcile('app', [{ ...sub('/'), coalesce: true }])
	await until(() => host.opened.length === 3 && host.live().length === 1, 'restarted coalescing')
	expect(host.opened[1]?.stopped).toBe(true)
	const before = params.length
	for (let i = 11; i <= 15; i++) host.opened[2]?.emit(i)
	await flush()
	expect(params.slice(before)).toEqual([11])
})
