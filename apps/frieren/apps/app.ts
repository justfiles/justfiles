// An App wraps an Engine with the metadata the runtime needs to mount it:
// a UI bundle for the iframe host and agent tools / briefing / narration.
// The Engine is the pure core; the App is everything around it.
//
// Use `app(...)` to construct one. Defaults:
//   - agent.createTools is auto-derived from engine.actionSchemas:
//       <id>_state                 always
//       <id>_<actionType>          one per schema key, with payload validation
//       <id>_dispatch              fallback when no schemas are declared
//   - agent.narrate stringifies the transition; override for nicer prose.

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import { type Static, type TSchema, Type } from '@sinclair/typebox'
import type { Action, Actor, Engine } from './engine'
import type { Session, Transition } from './session'

export interface App<S, A extends Action, TActor extends Actor, V> {
	id: string
	name: string
	description: string
	engine: Engine<S, A, TActor, V>
	done?(state: S): boolean
	ui?: {
		entry: string
		assets: Record<string, string>
	}
	agent?: {
		briefing?: string
		createTools?(args: AgentToolArgs<S, A, TActor, V>): AgentTool[]
		narrate?(transition: Transition<S, A, TActor>, view: V): string | null
	}
}

export interface AgentToolArgs<S, A extends Action, TActor extends Actor, V> {
	getSession: () => Session<S, A, TActor, V> | null
	agentActor: TActor
}

// biome-ignore lint/suspicious/noExplicitAny: existential erasure at the registry boundary
export type AnyApp = App<any, Action, Actor, any>

// Single factory: builds an App with sensible agent defaults filled in.
export function app<S, A extends Action, V>(
	spec: App<S, A, Actor, V> & { ui?: AppUi }
): App<S, A, Actor, V> {
	return {
		...spec,
		agent: {
			briefing: spec.agent?.briefing ?? `${spec.name} launched.`,
			createTools:
				spec.agent?.createTools ??
				((args) => buildDefaultTools(spec, args.getSession, args.agentActor)),
			narrate: spec.agent?.narrate ?? defaultNarrate(spec.name)
		}
	}
}

type AppUi = NonNullable<App<unknown, Action, Actor, unknown>['ui']>

function defaultNarrate<S, A extends Action, V>(
	appName: string
): NonNullable<NonNullable<App<S, A, Actor, V>['agent']>['narrate']> {
	return (transition, view) => {
		const who = transition.actor.kind ?? 'actor'
		return `The ${who} ran ${transition.action.type}. Latest ${appName} view:\n${JSON.stringify(view, null, 2)}`
	}
}

function buildDefaultTools<S, A extends Action, V>(
	spec: App<S, A, Actor, V>,
	getSession: () => Session<S, A, Actor, V> | null,
	agentActor: Actor
): AgentTool[] {
	const tools: AgentTool[] = [stateTool(spec, getSession, agentActor)]
	const schemas = spec.engine.actionSchemas
	if (schemas && Object.keys(schemas).length > 0) {
		for (const [type, schema] of Object.entries(schemas)) {
			tools.push(perActionTool(spec, type, schema, getSession, agentActor))
		}
	} else {
		tools.push(genericDispatchTool(spec, getSession, agentActor))
	}
	return tools
}

const emptyParams = Type.Object({})

function stateTool<S, A extends Action, V>(
	spec: App<S, A, Actor, V>,
	getSession: () => Session<S, A, Actor, V> | null,
	agentActor: Actor
): AgentTool {
	const tool: AgentTool<typeof emptyParams> = {
		name: `${spec.id}_state`,
		label: `${spec.name}: state`,
		description: `Read the current ${spec.name} state from your perspective.`,
		parameters: emptyParams,
		async execute() {
			const s = getSession()
			if (!s) return noActive(spec.name)
			const view = s.view(agentActor)
			return {
				content: [{ type: 'text', text: JSON.stringify(view, null, 2) }],
				details: { active: true, view }
			}
		}
	}
	return tool as unknown as AgentTool
}

function perActionTool<S, A extends Action, V, P extends TSchema>(
	spec: App<S, A, Actor, V>,
	type: string,
	payloadSchema: P,
	getSession: () => Session<S, A, Actor, V> | null,
	agentActor: Actor
): AgentTool {
	const tool: AgentTool<P> = {
		name: `${spec.id}_${type}`,
		label: `${spec.name}: ${type}`,
		description: `Submit a ${type} action to ${spec.name}.`,
		parameters: payloadSchema,
		async execute(_id, payload: Static<P>) {
			const s = getSession()
			if (!s) return noActive(spec.name)
			const result = s.dispatch(agentActor, { type, payload } as unknown as A)
			return dispatchResult(s, agentActor, result)
		}
	}
	return tool as unknown as AgentTool
}

function genericDispatchTool<S, A extends Action, V>(
	spec: App<S, A, Actor, V>,
	getSession: () => Session<S, A, Actor, V> | null,
	agentActor: Actor
): AgentTool {
	const params = Type.Object({
		type: Type.String({ description: 'Action type' }),
		payload: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
	})
	const tool: AgentTool<typeof params> = {
		name: `${spec.id}_dispatch`,
		label: `${spec.name}: dispatch`,
		description: `Submit an action to ${spec.name}.`,
		parameters: params,
		async execute(_id, p) {
			const s = getSession()
			if (!s) return noActive(spec.name)
			const result = s.dispatch(agentActor, {
				type: p.type,
				payload: p.payload ?? {}
			} as unknown as A)
			return dispatchResult(s, agentActor, result)
		}
	}
	return tool as unknown as AgentTool
}

function dispatchResult<S, A extends Action, V>(
	s: Session<S, A, Actor, V>,
	agentActor: Actor,
	result: { ok: true; state: S } | { ok: false; error: string }
): AgentToolResult<{ ok: boolean; view?: V; error?: string }> {
	if (!result.ok) {
		return {
			content: [{ type: 'text', text: `Rejected: ${result.error}` }],
			details: { ok: false, error: result.error }
		}
	}
	const view = s.view(agentActor)
	return {
		content: [{ type: 'text', text: `OK. New view:\n${JSON.stringify(view, null, 2)}` }],
		details: { ok: true, view }
	}
}

function noActive(name: string): AgentToolResult<{ active: false }> {
	return {
		content: [{ type: 'text', text: `No active ${name}.` }],
		details: { active: false }
	}
}
