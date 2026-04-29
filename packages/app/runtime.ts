// Pure, transport- and persistence-free helpers around an App. Both the
// frieren CF host and the @justfiles/app/server dev harness call these with
// their own state container — neither concept leaks into here.

import type Type from 'typebox'
import { Check, Errors } from 'typebox/value'
import type { App } from './app.js'
import type {
	Action,
	ActionFromStates,
	Actor,
	Snapshot,
	StateDef,
	StateDefs,
	TransitionDef
} from './engine.js'

export type DispatchOk<S, V> = {
	ok: true
	prev: S
	next: S
	view: V
	narration?: string | null
	availableActions?: readonly Action[] | null
}
export type DispatchErr = { ok: false; error: string }
export type DispatchResult<S, V> = DispatchOk<S, V> | DispatchErr

export type ToolDescriptor = { name: string; description?: string; parameters: unknown }

export function initial<
	TState extends string,
	TContext,
	States extends StateDefs<TState, TContext, TActor>,
	TActor extends Actor,
	V
>(app: App<TState, TContext, States, TActor, V>): Snapshot<TState, TContext> {
	return { state: app.engine.initial, context: app.engine.context }
}

export function dispatch<
	TState extends string,
	TContext,
	States extends StateDefs<TState, TContext, TActor>,
	TActor extends Actor,
	V
>(
	app: App<TState, TContext, States, TActor, V>,
	state: Snapshot<TState, TContext>,
	action: Action,
	actor: TActor
): DispatchResult<Snapshot<TState, TContext>, V> {
	const def = app.engine.states[state.state]?.on?.[action.type]
	if (!def) {
		return transitionDef(app, action.type)
			? { ok: false, error: `not allowed in state ${state.state}: ${action.type}` }
			: { ok: false, error: `unknown action: ${action.type}` }
	}
	if (!Check(def.schema, action.payload)) {
		const msg = Errors(def.schema, action.payload)
			.map((e) => `${e.instancePath || '/'} ${e.message}`)
			.join('; ')
		return { ok: false, error: `invalid payload: ${msg}` }
	}
	const typed = action as ActionFromStates<States>
	if (!allowsTransition(def, state, typed, actor)) {
		return { ok: false, error: `not allowed: ${action.type}` }
	}
	const args = { snapshot: state, context: state.context, action: typed, actor }
	const next = {
		state: def.target ?? state.state,
		context: def.actions ? def.actions(args) : state.context
	}
	const v = view(app, next, actor)
	const result: DispatchOk<Snapshot<TState, TContext>, V> = { ok: true, prev: state, next, view: v }
	if (app.agent?.narrate) {
		result.narration = app.agent.narrate({ prev: state, next, action: typed, actor }, v)
	}
	result.availableActions = availableActions(app, next, actor)
	return result
}

export function view<
	TState extends string,
	TContext,
	States extends StateDefs<TState, TContext, TActor>,
	TActor extends Actor,
	V
>(
	app: App<TState, TContext, States, TActor, V>,
	state: Snapshot<TState, TContext>,
	actor: TActor
): V {
	return app.engine.view ? app.engine.view(state, actor) : (state as unknown as V)
}

export function tools<
	TState extends string,
	TContext,
	States extends StateDefs<TState, TContext, TActor>,
	TActor extends Actor,
	V
>(app: App<TState, TContext, States, TActor, V>): ToolDescriptor[] {
	return Object.entries(transitionDefs(app)).map(([name, def]) => ({
		name,
		description: def.description,
		parameters: def.schema
	}))
}

export function allows<
	TState extends string,
	TContext,
	States extends StateDefs<TState, TContext, TActor>,
	TActor extends Actor,
	V
>(
	app: App<TState, TContext, States, TActor, V>,
	state: Snapshot<TState, TContext>,
	actor: TActor,
	action: Action
): boolean {
	const def = app.engine.states[state.state]?.on?.[action.type]
	return !!def && Check(def.schema, action.payload) && allowsTransition(def, state, action, actor)
}

export function availableActions<
	TState extends string,
	TContext,
	States extends StateDefs<TState, TContext, TActor>,
	TActor extends Actor,
	V
>(
	app: App<TState, TContext, States, TActor, V>,
	state: Snapshot<TState, TContext>,
	actor: TActor
): readonly Action[] | null {
	const entries = Object.entries(app.engine.states[state.state]?.on ?? {})
	return entries
		.filter(([type, def]) => allowsTransition(def, state, { type, payload: {} }, actor))
		.map(([type]) => ({ type, payload: {} }))
}

export function done<
	TState extends string,
	TContext,
	States extends StateDefs<TState, TContext, TActor>,
	TActor extends Actor,
	V
>(app: App<TState, TContext, States, TActor, V>, state: Snapshot<TState, TContext>): boolean {
	return app.done ? app.done(state) : false
}

export function briefing<
	TState extends string,
	TContext,
	States extends StateDefs<TState, TContext, TActor>,
	TActor extends Actor,
	V
>(app: App<TState, TContext, States, TActor, V>): string | null {
	return app.agent?.briefing ?? null
}

function transitionDefs<
	TState extends string,
	TContext,
	States extends StateDefs<TState, TContext, TActor>,
	TActor extends Actor,
	V
>(
	app: App<TState, TContext, States, TActor, V>
): Record<string, TransitionDef<Type.TSchema, TState, TContext, TActor>> {
	const defs: Record<string, TransitionDef<Type.TSchema, TState, TContext, TActor>> = {}
	for (const state of Object.values(app.engine.states) as StateDef<TState, TContext, TActor>[]) {
		for (const [type, def] of Object.entries(state.on ?? {})) defs[type] ??= def
	}
	return defs
}

function transitionDef<
	TState extends string,
	TContext,
	States extends StateDefs<TState, TContext, TActor>,
	TActor extends Actor,
	V
>(
	app: App<TState, TContext, States, TActor, V>,
	type: string
): TransitionDef<Type.TSchema, TState, TContext, TActor> | undefined {
	return transitionDefs(app)[type]
}

function allowsTransition<
	TState extends string,
	TContext,
	TAction extends Action,
	TActor extends Actor
>(
	def: TransitionDef<Type.TSchema, TState, TContext, TActor>,
	snapshot: Snapshot<TState, TContext>,
	action: TAction,
	actor: TActor
): boolean {
	const args = { snapshot, context: snapshot.context, action, actor }
	if (def.actor) {
		if (typeof def.actor === 'function' && !def.actor(args)) return false
		if (typeof def.actor === 'string' && !actorMatches(actor, [def.actor])) return false
		if (Array.isArray(def.actor) && !actorMatches(actor, def.actor)) return false
	}
	return def.guard ? def.guard(args) : true
}

function actorMatches(actor: Actor, names: readonly string[]): boolean {
	return [actor.id, actor.kind, actor.role].some(
		(name) => name !== undefined && names.includes(name)
	)
}
