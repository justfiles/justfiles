import type { Kernel } from '@justfiles/app'
import type { EffectContext } from '@justfiles/state'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Volume } from '../fs'
import { makeKernelHostEffect, makePersistEffect } from './effects'
import { saveSnapshot } from './persistence'
import { initialState, type OsAction, type OsState, type OsWindow } from './state'

vi.mock('./persistence', async (importOriginal) => ({
	...(await importOriginal<typeof import('./persistence')>()),
	saveSnapshot: vi.fn()
}))

function ctx(state: OsState): EffectContext<OsState, OsAction> {
	return { getState: () => state, dispatch: () => {} }
}

function makeWindow(id: string): OsWindow {
	return { id, kind: 'app', appId: id, mode: 'floating' }
}

function makeAgentWindow(): OsWindow {
	return { id: 'agent', kind: 'agent', mode: 'floating' }
}

function setup() {
	const appHost = { open: vi.fn(), close: vi.fn() }
	const send = vi.fn()
	const localKernel = async () => ({}) as Kernel
	const volume = Promise.resolve({} as Volume)
	const effect = makeKernelHostEffect({ appHost, send, localKernel, volume })
	// Every window opens with the same options now (no per-app branching).
	const opts = { localKernel, volume }
	return { appHost, send, opts, effect }
}

describe('makeKernelHostEffect', () => {
	test('app.open opens a host stage and notifies the server', () => {
		const { appHost, send, opts, effect } = setup()
		const action: OsAction = { type: 'app.open', appId: 'notes', title: 'Notes' }

		effect(action, initialState, initialState, ctx(initialState))

		expect(appHost.open).toHaveBeenCalledWith('notes', opts)
		expect(send).toHaveBeenCalledWith({ type: 'app_open', id: 'notes' })
	})

	test('remote app.open mounts the stage without echoing to the server', () => {
		const { appHost, send, effect } = setup()
		const action: OsAction = { type: 'app.open', appId: 'notes', remote: true }

		effect(action, initialState, initialState, ctx(initialState))

		expect(appHost.open).toHaveBeenCalledTimes(1)
		expect(send).not.toHaveBeenCalled()
	})

	test('window.close tears down the stage and notifies the server', () => {
		const { appHost, send, effect } = setup()
		const previous: OsState = {
			...initialState,
			windows: { notes: makeWindow('notes') },
			openOrder: ['notes'],
			focusStack: ['notes']
		}
		const action: OsAction = { type: 'window.close', id: 'notes' }

		effect(action, previous, initialState, ctx(initialState))

		expect(appHost.close).toHaveBeenCalledWith('notes')
		expect(send).toHaveBeenCalledWith({ type: 'app_close', id: 'notes' })
	})

	test('remote window.close tears down the stage without echoing to the server', () => {
		const { appHost, send, effect } = setup()
		const previous: OsState = {
			...initialState,
			windows: { notes: makeWindow('notes') },
			openOrder: ['notes'],
			focusStack: ['notes']
		}
		const action: OsAction = { type: 'window.close', id: 'notes', remote: true }

		effect(action, previous, initialState, ctx(initialState))

		expect(appHost.close).toHaveBeenCalledWith('notes')
		expect(send).not.toHaveBeenCalled()
	})

	test('closing the agent window touches neither the app host nor the server', () => {
		const { appHost, send, effect } = setup()
		const previous: OsState = {
			...initialState,
			windows: { agent: makeAgentWindow() },
			openOrder: ['agent'],
			focusStack: ['agent']
		}

		effect({ type: 'window.close', id: 'agent' }, previous, initialState, ctx(initialState))

		expect(appHost.close).not.toHaveBeenCalled()
		expect(send).not.toHaveBeenCalled()
	})

	test('boot/loaded opens a host stage for every restored window', () => {
		const { appHost, opts, effect } = setup()
		const restored: OsState = {
			...initialState,
			booted: true,
			windows: { notes: makeWindow('notes'), paint: makeWindow('paint'), agent: makeAgentWindow() },
			openOrder: ['notes', 'paint', 'agent'],
			focusStack: ['notes', 'paint', 'agent']
		}

		effect({ type: 'boot/loaded', state: restored }, initialState, restored, ctx(restored))

		// The agent window has no stage: only the two app windows open one.
		expect(appHost.open).toHaveBeenCalledTimes(2)
		expect(appHost.open).toHaveBeenCalledWith('notes', opts)
		expect(appHost.open).toHaveBeenCalledWith('paint', opts)
	})

	test('boot restoration does not echo app_open to the server', () => {
		const { send, effect } = setup()
		const restored: OsState = {
			...initialState,
			booted: true,
			windows: { notes: makeWindow('notes') },
			openOrder: ['notes'],
			focusStack: ['notes']
		}

		effect({ type: 'boot/loaded', state: restored }, initialState, restored, ctx(restored))

		expect(send).not.toHaveBeenCalled()
	})
})

describe('makePersistEffect', () => {
	const volume = Promise.resolve({} as Volume)
	const booted = (over: Partial<OsState> = {}): OsState => ({
		...initialState,
		booted: true,
		...over
	})
	// Two microtask turns to drain the `volume.then(saveSnapshot)` chain.
	const tick = async () => {
		await Promise.resolve()
		await Promise.resolve()
	}

	beforeEach(() => {
		vi.useFakeTimers()
		vi.mocked(saveSnapshot).mockReset()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	test('writes a discrete durable change promptly, without waiting on a timer', async () => {
		const { effect } = makePersistEffect({ volume })
		const next = booted({
			windows: { agent: makeAgentWindow() },
			openOrder: ['agent'],
			focusStack: ['agent']
		})

		effect({ type: 'agent.openWindow' }, initialState, next, ctx(next))
		await tick()

		expect(saveSnapshot).toHaveBeenCalledTimes(1)
		expect(saveSnapshot).toHaveBeenCalledWith({}, JSON.stringify(next))
	})

	test('debounces geometry changes until the timer elapses', async () => {
		const { effect } = makePersistEffect({ volume })
		const next = booted({ windows: { a: makeWindow('a') }, openOrder: ['a'], focusStack: ['a'] })

		effect(
			{ type: 'window.rectUpdated', id: 'a', rect: { x: 1, y: 2, w: 3, h: 4 } },
			initialState,
			next,
			ctx(next)
		)
		await tick()
		expect(saveSnapshot).not.toHaveBeenCalled()

		vi.advanceTimersByTime(300)
		await tick()
		expect(saveSnapshot).toHaveBeenCalledTimes(1)
	})

	test('flush() writes a pending debounced change immediately', async () => {
		const { effect, flush } = makePersistEffect({ volume })
		const next = booted({ windows: { a: makeWindow('a') }, openOrder: ['a'], focusStack: ['a'] })

		effect(
			{ type: 'window.rectUpdated', id: 'a', rect: { x: 1, y: 2, w: 3, h: 4 } },
			initialState,
			next,
			ctx(next)
		)
		flush()
		await tick()

		expect(saveSnapshot).toHaveBeenCalledTimes(1)
	})

	test('does not rewrite identical state', async () => {
		const { effect } = makePersistEffect({ volume })
		const next = booted({
			windows: { agent: makeAgentWindow() },
			openOrder: ['agent'],
			focusStack: ['agent']
		})

		effect({ type: 'agent.openWindow' }, initialState, next, ctx(next))
		await tick()
		effect({ type: 'agent.openWindow' }, next, next, ctx(next))
		await tick()

		expect(saveSnapshot).toHaveBeenCalledTimes(1)
	})

	test('boot/loaded seeds the baseline without writing', async () => {
		const { effect } = makePersistEffect({ volume })
		const next = booted()

		effect({ type: 'boot/loaded', state: next }, initialState, next, ctx(next))
		await tick()
		expect(saveSnapshot).not.toHaveBeenCalled()

		// A later action that lands on the already-persisted state is a no-op.
		effect({ type: 'window.focus', id: 'x' }, next, next, ctx(next))
		await tick()
		expect(saveSnapshot).not.toHaveBeenCalled()
	})
})
