import { describe, expect, test } from 'bun:test'
import type { Action, Actor, Engine } from '../engine'
import { session } from '../session'

type S = { n: number }
type A = Action<'inc' | 'add' | 'forbidden', { value?: number }>

const engine: Engine<S, A, Actor, S> = {
	initial: { n: 0 },
	step(state, action) {
		switch (action.type) {
			case 'inc':
				return { n: state.n + 1 }
			case 'add':
				return { n: state.n + (action.payload.value ?? 0) }
			case 'forbidden':
				return state
		}
	},
	allows(_state, _actor, action) {
		return action.type !== 'forbidden'
	}
}

const actor: Actor = { id: 'u', kind: 'human' }

describe('session', () => {
	test('dispatch updates state and returns new value', () => {
		const s = session(engine)
		const r = s.dispatch(actor, { type: 'inc', payload: {} })
		expect(r.ok).toBe(true)
		if (r.ok) expect(r.state.n).toBe(1)
		expect(s.state().n).toBe(1)
	})

	test('allows() rejection leaves state unchanged', () => {
		const s = session(engine)
		s.dispatch(actor, { type: 'inc', payload: {} })
		const r = s.dispatch(actor, { type: 'forbidden', payload: {} })
		expect(r.ok).toBe(false)
		if (!r.ok) expect(r.error).toBe('forbidden')
		expect(s.state().n).toBe(1)
	})

	test('subscribe fires with prev/next/action/actor on each transition', () => {
		const s = session(engine)
		const seen: Array<{ prev: number; next: number; type: string }> = []
		const off = s.subscribe((t) => {
			seen.push({ prev: t.prev.n, next: t.next.n, type: t.action.type })
		})
		s.dispatch(actor, { type: 'inc', payload: {} })
		s.dispatch(actor, { type: 'add', payload: { value: 5 } })
		off()
		s.dispatch(actor, { type: 'inc', payload: {} })
		expect(seen).toEqual([
			{ prev: 0, next: 1, type: 'inc' },
			{ prev: 1, next: 6, type: 'add' }
		])
	})

	test('rejected dispatch does not append to log', () => {
		const s = session(engine)
		s.dispatch(actor, { type: 'inc', payload: {} })
		s.dispatch(actor, { type: 'forbidden', payload: {} })
		const log = s.log()
		expect(log).toHaveLength(1)
		expect(log[0]?.action.type).toBe('inc')
		expect(log[0]?.actorId).toBe('u')
	})

	test('log is bounded by maxLog', () => {
		const s = session(engine, { maxLog: 3 })
		for (let i = 0; i < 5; i++) s.dispatch(actor, { type: 'inc', payload: {} })
		expect(s.log()).toHaveLength(3)
		expect(s.state().n).toBe(5)
	})

	test('initial and log restoration', () => {
		const seed = [
			{ at: 1, actorId: 'u', action: { type: 'inc' as const, payload: {} } },
			{ at: 2, actorId: 'u', action: { type: 'add' as const, payload: { value: 10 } } }
		]
		const s = session(engine, { initial: { n: 11 }, log: seed })
		expect(s.state().n).toBe(11)
		expect(s.log()).toHaveLength(2)
	})
})
