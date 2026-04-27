// An App pairs a pure Engine with the surface needed to embed it: a host-side
// id/name/description, an optional `done` predicate, and an optional `agent`
// section (briefing for launch, narrate for per-action prompting).
//
// UI and tools are NOT on the App type:
//   - assets live next to app.js in worker/dynamic/<id>/ and are served by the
//     host on /apps/<id>/* with a fixed `index.html` entry.
//   - agent tools are auto-derived from engine.actions inside the dynamic-worker
//     facet; the supervisor synthesizes callable AgentTools from descriptors.

import type { ActionDefs, ActionFromDefs, Actor, Engine } from './engine'

export interface App<S, D extends ActionDefs, TActor extends Actor, V> {
	id: string
	name: string
	description: string
	engine: Engine<S, D, TActor, V>
	done?(state: S): boolean
	agent?: {
		briefing?: string
		narrate?(transition: Transition<S, ActionFromDefs<D>, TActor>, view: V): string | null
	}
}

export type Transition<S, A, TActor> = {
	prev: S
	next: S
	action: A
	actor: TActor
}

// biome-ignore lint/suspicious/noExplicitAny: existential erasure at the registry boundary
export type AnyApp = App<any, any, Actor, any>
