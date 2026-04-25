// Closest-guess card game.
//
// Someone deals a hidden card (1-100). Two or more players each submit a guess.
// When someone calls reveal, the card is shown and whoever was closest wins.

import type { Action, Actor, Engine } from '../engine'

export type Phase = 'setup' | 'guessing' | 'revealed'

export type CardState = {
	phase: Phase
	card: number | null
	guesses: Record<string, number>
	winner: string | null
}

export type CardAction =
	| Action<'deal', { card: number }>
	| Action<'guess', { value: number }>
	| Action<'reveal', object>

export type CardView = {
	phase: Phase
	card: number | null
	myGuess: number | null
	otherGuesses: Record<string, number | 'submitted'>
	winner: string | null
}

function closestTo(card: number, guesses: Record<string, number>): string | null {
	let winner: string | null = null
	let best = Infinity
	for (const [id, g] of Object.entries(guesses)) {
		const d = Math.abs(card - g)
		if (d < best) {
			winner = id
			best = d
		}
	}
	return winner
}

export const cardEngine: Engine<CardState, CardAction, Actor, CardView> = {
	initial: {
		phase: 'setup',
		card: null,
		guesses: {},
		winner: null
	},

	step(state, action, actor) {
		switch (action.type) {
			case 'deal': {
				return {
					phase: 'guessing',
					card: action.payload.card,
					guesses: {},
					winner: null
				}
			}
			case 'guess': {
				return {
					...state,
					guesses: { ...state.guesses, [actor.id]: action.payload.value }
				}
			}
			case 'reveal': {
				const winner = state.card !== null ? closestTo(state.card, state.guesses) : null
				return { ...state, phase: 'revealed', winner }
			}
		}
	},

	allows(state, _actor, action) {
		switch (action.type) {
			case 'deal':
				return state.phase === 'setup'
			case 'guess': {
				if (state.phase !== 'guessing') return false
				const value = action.payload.value
				return Number.isInteger(value) && value >= 1 && value <= 100
			}
			case 'reveal':
				return state.phase === 'guessing' && Object.keys(state.guesses).length >= 2
		}
	},

	view(state, actor) {
		const myGuess = state.guesses[actor.id] ?? null

		const otherGuesses: Record<string, number | 'submitted'> = {}
		for (const [id, g] of Object.entries(state.guesses)) {
			if (id === actor.id) continue
			otherGuesses[id] = state.phase === 'revealed' ? g : 'submitted'
		}

		return {
			phase: state.phase,
			card: state.phase === 'revealed' ? state.card : null,
			myGuess,
			otherGuesses,
			winner: state.winner
		}
	}
}
