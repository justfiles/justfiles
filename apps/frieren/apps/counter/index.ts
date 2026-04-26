import { Type } from '@sinclair/typebox'
import { app } from '../app'
import type { Action, Actor, Engine } from '../engine'
import script from './counter.js?raw'
import html from './index.html?raw'

type CounterState = { count: number }
type CounterAction =
	| Action<'increment', object>
	| Action<'decrement', object>
	| Action<'reset', object>

const counterEngine: Engine<CounterState, CounterAction, Actor, CounterState> = {
	initial: { count: 0 },
	step(state, action) {
		switch (action.type) {
			case 'increment':
				return { count: state.count + 1 }
			case 'decrement':
				return { count: state.count - 1 }
			case 'reset':
				return { count: 0 }
		}
	},
	actionSchemas: {
		increment: Type.Object({}),
		decrement: Type.Object({}),
		reset: Type.Object({})
	}
}

export const counterApp = app({
	id: 'counter',
	name: 'Counter',
	description: 'A tiny app that increments, decrements, and resets shared state.',
	engine: counterEngine,
	ui: {
		entry: 'index.html',
		assets: { 'index.html': html, 'counter.js': script }
	},
	agent: {
		briefing:
			'A counter app just launched. Inspect with counter_state and update with counter_increment, counter_decrement, or counter_reset.'
	}
})
