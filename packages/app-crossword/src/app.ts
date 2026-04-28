import { defineApp, defineEngine } from '@justfiles/app'
import { Type } from 'typebox'

const actions = {
	increment: { description: 'Increase the counter by one.', schema: Type.Object({}) },
	decrement: { description: 'Decrease the counter by one.', schema: Type.Object({}) },
	reset: { description: 'Reset the counter to zero.', schema: Type.Object({}) }
}

const engine = defineEngine({
	initial: { count: 0 },
	actions,
	step(state, action) {
		switch (action.type) {
			case 'increment':
				return { count: state.count + 1 }
			case 'decrement':
				return { count: state.count - 1 }
			case 'reset':
				return { count: 0 }
		}
	}
})

export default defineApp({
	name: 'Crossword',
	description: 'POC stand-in: counter logic until the real crossword lands.',
	engine,
	agent: {
		briefing:
			'A counter is open. Inspect with counter_state; act with counter_increment, counter_decrement, or counter_reset.',
		narrate({ action, actor }, view) {
			const who = actor.kind ?? 'actor'
			return `The ${who} ran ${action.type}. Latest counter view:\n${JSON.stringify(view, null, 2)}`
		}
	}
})
