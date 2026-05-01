import { defineApp, defineEngine } from '@justfiles/app'

const engine = defineEngine({
	initial: 'playing',
	context: {},
	states: {
		playing: {}
	}
})

export default defineApp({
	name: 'Doom',
	description: 'Play Doom in the browser.',
	engine,
	agent: {
		briefing: 'The Doom game is mounted in the browser canvas.'
	}
})
