import { app } from '../app'
import cardScript from './card.js?raw'
import { type CardAction, type CardView, cardEngine } from './engine'
import html from './index.html?raw'

const briefing =
	'A card-guessing game just launched in idle state. Deal first: pick a hidden number 1-100 ' +
	'and call card_deal with { card: <number> }. Then you and the user each call card_guess ' +
	'with { value: <1-100> }. Do not reveal — the user clicks Reveal when ready. ' +
	'Call card_state any time to see the latest view.'

function narrate(
	transition: { action: CardAction; actor: { id: string } },
	view: CardView
): string {
	const { action } = transition
	if (action.type === 'reveal') {
		const winner =
			view.winner === null
				? 'nobody'
				: view.winner === 'user'
					? 'the user'
					: view.winner === 'agent'
						? 'you'
						: view.winner
		return `The user revealed. Card was ${view.card}. Your guess: ${view.myGuess}. Winner: ${winner}. React and wrap up.`
	}
	return `The user just played: ${JSON.stringify(action)}. Latest view:\n${JSON.stringify(view, null, 2)}`
}

export const cardApp = app({
	id: 'card',
	name: 'Card',
	description: 'A closest-guess card game for two players.',
	engine: cardEngine,
	done: (state) => state.phase === 'revealed',
	ui: {
		entry: 'index.html',
		assets: { 'index.html': html, 'card.js': cardScript }
	},
	agent: { briefing, narrate }
})
