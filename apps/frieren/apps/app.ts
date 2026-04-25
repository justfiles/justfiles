// An App wraps an Engine with the metadata the runtime needs to mount it:
// a UI bundle for the iframe host, agent tools + briefing, and an optional
// terminal-state predicate. The Engine is the pure core; the App is
// everything around it. Agent-facing concerns live under `agent`, iframe
// assets under `ui`.

import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { Action, Actor, Engine } from './engine'
import type { Session } from './session'

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
		createTools?(args: {
			getSession: () => Session<S, A, TActor, V> | null
			agentActor: TActor
		}): AgentTool[]
		describeUserMove?(action: A, view: V): string
	}
}

// Loose type so the runtime can hold heterogeneous apps in a registry.
// biome-ignore lint/suspicious/noExplicitAny: existential erasure at the registry boundary
export type AnyApp = App<any, Action, Actor, any>
