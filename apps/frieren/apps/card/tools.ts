// Card game: agent tools + briefing. Assembles the App bundle.
//
// No lifecycle hooks — the game enters its playable state via a regular
// 'deal' action dispatched through the session, like any other move.

import type { AgentTool } from '@mariozechner/pi-agent-core'
import { Type } from '@sinclair/typebox'
import type { Actor } from '../engine'
import type { Session } from '../session'
import type { CardAction, CardState, CardView } from './engine'

export type CardSession = Session<CardState, CardAction, Actor, CardView>

export function describeUserMove(action: CardAction, view: CardView): string {
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

export const briefing =
	'A card-guessing game just launched in idle state. Deal first: pick a hidden number 1-100 ' +
	'and call game_act with { type: "deal", payload: { card: <number> } }. ' +
	'Then you and the user each guess. Do not reveal — the user clicks Reveal when ready. ' +
	'Call get_current_state any time to see the latest state.'

const actParams = Type.Object({
	type: Type.String({ description: 'Action type (e.g. "guess")' }),
	payload: Type.Unknown({ description: 'Action payload, shape depends on action type' })
})

const viewParams = Type.Object({})

export function createTools(args: {
	getSession: () => CardSession | null
	agentActor: Actor
}): AgentTool[] {
	const viewTool: AgentTool<typeof viewParams> = {
		name: 'get_current_state',
		label: 'Get Current State',
		description:
			'Fetch the current state of the active game at any time. Returns everything your actor can see — your own hand/guess, public info, and other players\' submissions when visible. Returns "No active game." if no game is running.',
		parameters: viewParams,
		async execute() {
			const s = args.getSession()
			if (!s) {
				return {
					content: [{ type: 'text', text: 'No active game.' }],
					details: { active: false }
				}
			}
			const view = s.view(args.agentActor)
			return {
				content: [{ type: 'text', text: JSON.stringify(view, null, 2) }],
				details: { active: true, view }
			}
		}
	}

	const actTool: AgentTool<typeof actParams> = {
		name: 'game_act',
		label: 'Game Act',
		description:
			'Submit an action to the active game as a player. For the card game: { type: "deal", payload: { card: <1-100> } } to start, or { type: "guess", payload: { value: <1-100> } } to guess. The user handles revealing.',
		parameters: actParams,
		async execute(_id, params) {
			const s = args.getSession()
			if (!s) {
				return {
					content: [{ type: 'text', text: 'No active game.' }],
					details: { active: false }
				}
			}
			const result = s.dispatch(args.agentActor, {
				type: params.type,
				payload: params.payload
			} as CardAction)
			if (!result.ok) {
				return {
					content: [{ type: 'text', text: `Rejected: ${result.error}` }],
					details: { ok: false, error: result.error }
				}
			}
			const view = s.view(args.agentActor)
			return {
				content: [{ type: 'text', text: `OK. New view:\n${JSON.stringify(view, null, 2)}` }],
				details: { ok: true, view }
			}
		}
	}

	// Variance: concrete AgentTool<TObject<{...}>> isn't assignable to the
	// homogeneous AgentTool<TSchema>[] the App contract expects.
	return [viewTool, actTool] as unknown as AgentTool[]
}
