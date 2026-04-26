import { describe, expect, test } from 'bun:test'
import { type CardAction, type CardState, cardEngine } from '../card/engine'
import type { Actor } from '../engine'

const user: Actor = { id: 'user', kind: 'human' }
const agent: Actor = { id: 'agent', kind: 'agent' }

const initial = (): CardState => structuredClone(cardEngine.initial)

const dispatch = (state: CardState, action: CardAction, actor: Actor) => {
	if (cardEngine.allows && !cardEngine.allows(state, actor, action))
		throw new Error(`forbidden: ${action.type}`)
	return cardEngine.step(state, action, actor)
}

const view = (state: CardState, actor: Actor) => {
	if (!cardEngine.view) throw new Error('view() is required for the card engine')
	return cardEngine.view(state, actor)
}

describe('card engine', () => {
	test('starts in setup phase with no card or guesses', () => {
		const s = initial()
		expect(s.phase).toBe('setup')
		expect(s.card).toBeNull()
		expect(s.guesses).toEqual({})
		expect(s.winner).toBeNull()
	})

	test('deal moves to guessing phase and stores card', () => {
		const s = dispatch(initial(), { type: 'deal', payload: { card: 42 } }, user)
		expect(s.phase).toBe('guessing')
		expect(s.card).toBe(42)
	})

	test('allows() forbids guess before deal', () => {
		expect(cardEngine.allows?.(initial(), user, { type: 'guess', payload: { value: 1 } })).toBe(
			false
		)
	})

	test('allows() forbids out-of-range and non-integer guesses', () => {
		const s = dispatch(initial(), { type: 'deal', payload: { card: 50 } }, user)
		expect(cardEngine.allows?.(s, user, { type: 'guess', payload: { value: 0 } })).toBe(false)
		expect(cardEngine.allows?.(s, user, { type: 'guess', payload: { value: 101 } })).toBe(false)
		expect(cardEngine.allows?.(s, user, { type: 'guess', payload: { value: 1.5 } })).toBe(false)
		expect(cardEngine.allows?.(s, user, { type: 'guess', payload: { value: 50 } })).toBe(true)
	})

	test('reveal requires at least two guesses', () => {
		let s = dispatch(initial(), { type: 'deal', payload: { card: 50 } }, user)
		s = dispatch(s, { type: 'guess', payload: { value: 40 } }, user)
		expect(cardEngine.allows?.(s, user, { type: 'reveal', payload: {} })).toBe(false)
		s = dispatch(s, { type: 'guess', payload: { value: 70 } }, agent)
		expect(cardEngine.allows?.(s, user, { type: 'reveal', payload: {} })).toBe(true)
	})

	test('reveal picks the closest guess as winner', () => {
		let s = dispatch(initial(), { type: 'deal', payload: { card: 50 } }, user)
		s = dispatch(s, { type: 'guess', payload: { value: 47 } }, user)
		s = dispatch(s, { type: 'guess', payload: { value: 60 } }, agent)
		s = dispatch(s, { type: 'reveal', payload: {} }, user)
		expect(s.phase).toBe('revealed')
		expect(s.winner).toBe('user')
	})

	test('view() hides the card and other guesses during guessing', () => {
		let s = dispatch(initial(), { type: 'deal', payload: { card: 77 } }, user)
		s = dispatch(s, { type: 'guess', payload: { value: 30 } }, user)
		s = dispatch(s, { type: 'guess', payload: { value: 80 } }, agent)
		const userView = view(s, user)
		expect(userView.card).toBeNull()
		expect(userView.myGuess).toBe(30)
		expect(userView.otherGuesses).toEqual({ agent: 'submitted' })
	})

	test('view() reveals everything after reveal', () => {
		let s = dispatch(initial(), { type: 'deal', payload: { card: 77 } }, user)
		s = dispatch(s, { type: 'guess', payload: { value: 30 } }, user)
		s = dispatch(s, { type: 'guess', payload: { value: 80 } }, agent)
		s = dispatch(s, { type: 'reveal', payload: {} }, user)
		const userView = view(s, user)
		expect(userView.card).toBe(77)
		expect(userView.otherGuesses).toEqual({ agent: 80 })
		expect(userView.winner).toBe('agent')
	})

	test('actionSchemas declares deal/guess/reveal', () => {
		expect(Object.keys(cardEngine.actionSchemas ?? {})).toEqual(['deal', 'guess', 'reveal'])
	})
})
