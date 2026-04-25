// Packages a plain App (engine + metadata) with an iframe UI bundle.
// The engine stays pure: its `view(state, actor)` returns whatever the app
// wants the iframe to see. The transport layer ships `ui.assets` on mount and
// `engine.view(...)` on every state change — see worker/frieren.ts.

import type { AgentTool } from '@mariozechner/pi-agent-core'
import { Type } from '@sinclair/typebox'
import type { App } from './app'
import type { Action, Actor } from './engine'
import type { Session } from './session'

const actParams = Type.Object({
	type: Type.String({ description: 'Action type from the active app' }),
	payload: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
})

const viewParams = Type.Object({})

export function defineApp<S, A extends Action>(app: App<S, A, Actor, S>): App<S, A, Actor, S> {
	return app
}

function defaultTools<S, A extends Action, V>(
	definition: App<S, A, Actor, V>,
	getSession: () => Session<S, A, Actor, V> | null,
	agentActor: Actor
): AgentTool[] {
	const viewTool: AgentTool<typeof viewParams> = {
		name: 'get_current_state',
		label: 'Get Current State',
		description: `Fetch the current state of ${definition.name}.`,
		parameters: viewParams,
		async execute() {
			const s = getSession()
			if (!s) {
				return {
					content: [{ type: 'text', text: 'No active app.' }],
					details: { active: false }
				}
			}

			const view = s.view(agentActor)
			return {
				content: [{ type: 'text', text: JSON.stringify(view, null, 2) }],
				details: { active: true, view }
			}
		}
	}

	const actTool: AgentTool<typeof actParams> = {
		name: 'game_act',
		label: 'Game Act',
		description: `Submit an action to ${definition.name}.`,
		parameters: actParams,
		async execute(_id, params) {
			const s = getSession()
			if (!s) {
				return {
					content: [{ type: 'text', text: 'No active app.' }],
					details: { active: false }
				}
			}

			const result = s.dispatch(agentActor, {
				type: params.type,
				payload: params.payload ?? {}
			} as unknown as A)
			if (!result.ok) {
				return {
					content: [{ type: 'text', text: `Rejected: ${result.error}` }],
					details: { ok: false, error: result.error }
				}
			}

			const view = s.view(agentActor)
			return {
				content: [{ type: 'text', text: `OK. New state:\n${JSON.stringify(view, null, 2)}` }],
				details: { ok: true, view }
			}
		}
	}

	return [viewTool, actTool] as unknown as AgentTool[]
}

export function iframeApp<S, A extends Action, V>(
	definition: App<S, A, Actor, V>,
	assets: Record<string, string>,
	entry = 'index.html'
): App<S, A, Actor, V> {
	return {
		...definition,
		ui: { entry, assets },
		agent: {
			briefing: definition.agent?.briefing ?? `${definition.name} launched.`,
			createTools:
				definition.agent?.createTools ??
				((args) => defaultTools(definition, args.getSession, args.agentActor)),
			describeUserMove:
				definition.agent?.describeUserMove ??
				((action, view) =>
					`The user ran ${action.type}. Current ${definition.name} state:\n${JSON.stringify(view, null, 2)}`)
		}
	}
}
