import { describe, expect, test, vi } from 'vitest'
import { createStore, type Reducer } from './index.ts'

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
