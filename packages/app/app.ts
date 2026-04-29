// An App pairs a pure Engine with the surface needed to embed it: a name,
// description, an optional `done` predicate, and an optional `agent` section
// (briefing for launch, narrate for per-action prompting).
//
// Convention: each app package's `package.json#main` resolves to a module
// that default-exports the App. `defineApp` injects an internal `__pkg`
// marker (when invoked under the `appBuilder` Vite plugin) so that hosts can
// round-trip an imported reference back to the package's directory.
//
// UI and tools are NOT on the App type:
//   - assets sit alongside the backend module in the package's content root
//     and are served as a flat bag by the host (see @justfiles/app/host).
//   - agent tools are auto-derived from engine transition descriptors inside the host's
//     dynamic-worker facet; the supervisor synthesizes callable AgentTools
//     from the transition descriptors.

import type { ActionFromStates, Actor, Engine, Snapshot, StateDefs } from './engine.js'

export interface App<
	TState extends string,
	TContext,
	States extends StateDefs<TState, TContext, TActor>,
	TActor extends Actor,
	V
> {
	name: string
	description: string
	engine: Engine<TState, TContext, States, TActor, V>
	done?(snapshot: Snapshot<TState, TContext>): boolean
	agent?: {
		briefing?: string
		narrate?(
			transition: Transition<TState, TContext, ActionFromStates<States>, TActor>,
			view: V
		): string | null
	}
	/**
	 * Set at build time by `appBuilder()` (via Vite's `define`) to the
	 * package's `package.json#name`. Hosts use it to map an imported app
	 * reference back to its package directory. Absent in dev / non-Vite
	 * builds; absence is fine outside of host registration.
	 */
	__pkg?: string
}

export type Transition<TState extends string, TContext, A, TActor> = {
	prev: Snapshot<TState, TContext>
	next: Snapshot<TState, TContext>
	action: A
	actor: TActor
}

// biome-ignore lint/suspicious/noExplicitAny: existential erasure at the registry boundary
export type AnyApp = App<any, any, any, Actor, any>

// `__JUSTFILES_PKG__` is replaced with the package name (a string literal)
// by `appBuilder()` via Vite's `define`. Outside that build it stays
// undefined; we guard with `typeof` so dev/test paths just see no `__pkg`.
declare const __JUSTFILES_PKG__: string

/**
 * Define an App with full type inference. Pass the app object literal and
 * `TState`, `TContext`, `States`, `TActor`, `V` are inferred from `engine` so `done` and
 * `agent.narrate` get correctly-typed `state`/`transition`/`view` params.
 */
export function define<
	TState extends string,
	TContext,
	States extends StateDefs<TState, TContext, TActor>,
	TActor extends Actor,
	V
>(app: App<TState, TContext, States, TActor, V>): App<TState, TContext, States, TActor, V> {
	const pkg = typeof __JUSTFILES_PKG__ !== 'undefined' ? __JUSTFILES_PKG__ : undefined
	return pkg ? { ...app, __pkg: pkg } : app
}
