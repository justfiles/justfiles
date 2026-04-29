import { defineApp, defineEngine } from '@justfiles/app'
import { Type } from 'typebox'

const engine = defineEngine({
	initial: 'counting',
	context: { count: 0 },
	states: {
		counting: {
			on: {
				increment: {
					description: 'Increase the counter by one.',
					schema: Type.Object({}),
					actions: ({ context }) => ({ count: context.count + 1 })
				},
				decrement: {
					description: 'Decrease the counter by one.',
					schema: Type.Object({}),
					actions: ({ context }) => ({ count: context.count - 1 })
				},
				reset: {
					description: 'Reset the counter to zero.',
					schema: Type.Object({}),
					actions: () => ({ count: 0 })
				}
			}
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
