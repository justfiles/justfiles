import type { App } from '../app'
import type { Actor } from '../engine'
import { iframeApp } from '../iframe'
import cardScript from './card.js?raw'
import { type CardAction, type CardState, type CardView, cardEngine } from './engine'
import html from './index.html?raw'
import { briefing, createTools, describeUserMove } from './tools'

const cardDefinition: App<CardState, CardAction, Actor, CardView> = {
	id: 'card',
	name: 'Card',
	description: 'A closest-guess card game for two players.',
	engine: cardEngine,
	done(state) {
		return state.phase === 'revealed'
	},
	agent: {
		briefing,
		createTools,
		describeUserMove
	}
}

export const cardApp = iframeApp(cardDefinition, {
	'index.html': html,
	'card.js': cardScript
})
