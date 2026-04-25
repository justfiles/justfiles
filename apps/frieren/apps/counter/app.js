import { defineApp } from '../iframe'

export default defineApp({
	id: 'counter',
	name: 'Counter',
	description: 'A tiny JavaScript app that increments, decrements, and resets shared state.',
	agent: {
		briefing:
			'A counter app just launched. You can inspect it with get_current_state and update it with game_act using increment, decrement, or reset.'
	},
	engine: {
		initial: { count: 0 },
		step(state, action) {
			switch (action.type) {
				case 'increment':
					return { ...state, count: Number(state.count ?? 0) + 1 }
				case 'decrement':
					return { ...state, count: Number(state.count ?? 0) - 1 }
				case 'reset':
					return { ...state, count: 0 }
				default:
					return state
			}
		}
	}
})
