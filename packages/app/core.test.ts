import { expect, test } from 'vitest'
import type { RuntimeContext } from './app.ts'
import { app, type CoreState, initialState } from './test-bundle/core.ts'

// The whole point of the pure core: edges are deterministic, synchronous, and
// testable with no kernel and no sandbox. We just call `app.dispatch` with a
// minimal ctx — capabilities are never touched, so `capabilityInvoke` is absent.
const ctx = (state: CoreState): RuntimeContext<CoreState> => ({ state })

test('public edge validates input, updates state, and emits a command', async () => {
	const out = await app.dispatch({ type: 'refresh', params: {} }, ctx(initialState))
	expect(out.state).toEqual({ files: [], loading: true, error: null })
	expect(out.command).toEqual({
		kind: 'capability',
		capability: 'volume',
		method: 'scan',
		input: { path: '/', recursive: true },
		to: 'filesLoaded'
	})
})

test('result edge folds an ok capability result into state', async () => {
	const out = await app.dispatch(
		{
			type: '__cmd/filesLoaded',
			params: {
				ok: true,
				value: [
					{ path: '/a.txt', type: 'file' },
					{ path: '/dir', type: 'dir' }
				]
			}
		},
		ctx({ ...initialState, loading: true })
	)
	expect(out.state).toEqual({ files: [{ path: '/a.txt' }], loading: false, error: null })
	expect(out.command).toBeUndefined()
})

test('result edge folds an err capability result into state', async () => {
	const out = await app.dispatch(
		{ type: '__cmd/filesLoaded', params: { ok: false, error: { message: 'denied' } } },
		ctx({ ...initialState, loading: true })
	)
	expect(out.state).toMatchObject({ loading: false, error: 'denied' })
})

test('only public edges appear in the action surface', () => {
	expect(Object.keys(app.actions)).toEqual(['refresh'])
})

test('internal edges are not dispatchable by their plain name', async () => {
	await expect(
		app.dispatch({ type: 'filesLoaded', params: { ok: true, value: [] } }, ctx(initialState))
	).rejects.toThrow(/unknown action: filesLoaded/)
})

test('a public edge rejects params that fail its schema before running', async () => {
	await expect(
		app.dispatch({ type: 'refresh', params: 'not-an-object' }, ctx(initialState))
	).rejects.toThrow(/invalid params for refresh/)
})
