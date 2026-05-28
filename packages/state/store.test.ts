import { describe, expect, test, vi } from 'vitest'
import { createStore, type Effect, type Reducer } from './index.ts'

type Counter = { n: number }
type Action = { type: 'inc' } | { type: 'noop' } | { type: 'set'; n: number }

const reducer: Reducer<Counter, Action> = (state, action) => {
	switch (action.type) {
		case 'inc':
			return { n: state.n + 1 }
		case 'set':
			return { n: action.n }
		case 'noop':
			return state
	}
}

describe('createStore', () => {
	test('getState returns initial state', () => {
		const store = createStore({ initialState: { n: 0 }, reducer })
		expect(store.getState()).toEqual({ n: 0 })
	})

	test('dispatch runs reducer and updates state', () => {
		const store = createStore({ initialState: { n: 0 }, reducer })
		store.dispatch({ type: 'inc' })
		expect(store.getState()).toEqual({ n: 1 })
		store.dispatch({ type: 'set', n: 10 })
		expect(store.getState()).toEqual({ n: 10 })
	})

	test('subscribe is notified after state change', () => {
		const store = createStore({ initialState: { n: 0 }, reducer })
		const listener = vi.fn()
		store.subscribe(listener)
		store.dispatch({ type: 'inc' })
		expect(listener).toHaveBeenCalledTimes(1)
	})

	test('no notification when reducer returns same state reference', () => {
		const store = createStore({ initialState: { n: 0 }, reducer })
		const listener = vi.fn()
		store.subscribe(listener)
		store.dispatch({ type: 'noop' })
		expect(listener).not.toHaveBeenCalled()
		expect(store.getState()).toEqual({ n: 0 })
	})

	test('unsubscribe stops further notifications', () => {
		const store = createStore({ initialState: { n: 0 }, reducer })
		const listener = vi.fn()
		const unsubscribe = store.subscribe(listener)
		store.dispatch({ type: 'inc' })
		unsubscribe()
		store.dispatch({ type: 'inc' })
		expect(listener).toHaveBeenCalledTimes(1)
	})

	test('re-entrant dispatch from subscriber is queued, not recursive', () => {
		const store = createStore({ initialState: { n: 0 }, reducer })
		const seen: number[] = []
		let dispatchedOnce = false
		store.subscribe(() => {
			seen.push(store.getState().n)
			if (!dispatchedOnce) {
				dispatchedOnce = true
				store.dispatch({ type: 'inc' })
			}
		})
		store.dispatch({ type: 'inc' })
		expect(seen).toEqual([1, 2])
		expect(store.getState()).toEqual({ n: 2 })
	})
})

describe('effects', () => {
	test('effect observes previous and next state', () => {
		const seen: Array<{ prev: number; next: number }> = []
		const effect: Effect<Counter, Action> = (_action, previous, next) => {
			seen.push({ prev: previous.n, next: next.n })
		}
		const store = createStore({ initialState: { n: 0 }, reducer, effects: [effect] })
		store.dispatch({ type: 'inc' })
		store.dispatch({ type: 'set', n: 5 })
		expect(seen).toEqual([
			{ prev: 0, next: 1 },
			{ prev: 1, next: 5 }
		])
	})

	test('effect can dispatch a follow-up action', () => {
		const effect: Effect<Counter, Action> = (action, _prev, _next, ctx) => {
			if (action.type === 'inc' && ctx.getState().n === 1) {
				ctx.dispatch({ type: 'set', n: 100 })
			}
		}
		const store = createStore({ initialState: { n: 0 }, reducer, effects: [effect] })
		store.dispatch({ type: 'inc' })
		expect(store.getState()).toEqual({ n: 100 })
	})

	test('async effect does not block state notification', () => {
		let release: () => void = () => {}
		const blocked = new Promise<void>((resolve) => {
			release = resolve
		})
		const effect: Effect<Counter, Action> = async () => {
			await blocked
		}
		const store = createStore({ initialState: { n: 0 }, reducer, effects: [effect] })
		const listener = vi.fn()
		store.subscribe(listener)
		store.dispatch({ type: 'inc' })
		expect(listener).toHaveBeenCalledTimes(1)
		expect(store.getState()).toEqual({ n: 1 })
		release()
	})

	test('re-entrant dispatch from inside an effect is queued, not recursive', () => {
		const order: string[] = []
		const effect: Effect<Counter, Action> = (action, _prev, next, ctx) => {
			order.push(`enter n=${next.n}`)
			if (action.type === 'inc' && next.n === 1) {
				ctx.dispatch({ type: 'inc' })
				order.push(`after-dispatch n=${ctx.getState().n}`)
			}
			order.push(`exit n=${next.n}`)
		}
		const store = createStore({ initialState: { n: 0 }, reducer, effects: [effect] })
		store.dispatch({ type: 'inc' })
		expect(order).toEqual(['enter n=1', 'after-dispatch n=1', 'exit n=1', 'enter n=2', 'exit n=2'])
		expect(store.getState()).toEqual({ n: 2 })
	})

	test('queued effect sees the post-outer state as its previous', () => {
		const seen: Array<{ prev: number; next: number }> = []
		let dispatched = false
		const effect: Effect<Counter, Action> = (action, previous, next, ctx) => {
			seen.push({ prev: previous.n, next: next.n })
			if (action.type === 'inc' && !dispatched) {
				dispatched = true
				ctx.dispatch({ type: 'inc' })
			}
		}
		const store = createStore({ initialState: { n: 0 }, reducer, effects: [effect] })
		store.dispatch({ type: 'inc' })
		expect(seen).toEqual([
			{ prev: 0, next: 1 },
			{ prev: 1, next: 2 }
		])
	})

	test('same-state reducer fires neither subscribers nor effects', () => {
		const effect = vi.fn()
		const store = createStore({ initialState: { n: 0 }, reducer, effects: [effect] })
		const listener = vi.fn()
		store.subscribe(listener)
		store.dispatch({ type: 'noop' })
		expect(listener).not.toHaveBeenCalled()
		expect(effect).not.toHaveBeenCalled()
	})

	test('a synchronous effect error is logged and does not throw', () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		const effect: Effect<Counter, Action> = () => {
			throw new Error('boom')
		}
		const store = createStore({ initialState: { n: 0 }, reducer, effects: [effect] })
		expect(() => store.dispatch({ type: 'inc' })).not.toThrow()
		expect(store.getState()).toEqual({ n: 1 })
		expect(errorSpy).toHaveBeenCalledOnce()
		errorSpy.mockRestore()
	})

	test('an async effect rejection is logged', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		const effect: Effect<Counter, Action> = async () => {
			throw new Error('async boom')
		}
		const store = createStore({ initialState: { n: 0 }, reducer, effects: [effect] })
		store.dispatch({ type: 'inc' })
		await Promise.resolve()
		expect(errorSpy).toHaveBeenCalledOnce()
		errorSpy.mockRestore()
	})
})
