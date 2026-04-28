// Pure, transport- and persistence-free helpers around an App. Both the
// frieren CF host and the @justfiles/app/server dev harness call these with
// their own state container — neither concept leaks into here.

import { Check, Errors } from 'typebox/value'
import type { App } from './app.js'
import type { Action, ActionDefs, ActionFromDefs, Actor } from './engine.js'

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

export function dispatch<S, D extends ActionDefs, TActor extends Actor, V>(
	app: App<S, D, TActor, V>,
	state: S,
	action: Action,
	actor: TActor
): DispatchResult<S, V> {
	const def = app.engine.actions[action.type]
	if (!def) return { ok: false, error: `unknown action: ${action.type}` }
	if (!Check(def.schema, action.payload)) {
		const msg = Errors(def.schema, action.payload)
			.map((e) => `${e.instancePath || '/'} ${e.message}`)
			.join('; ')
		return { ok: false, error: `invalid payload: ${msg}` }
	}
	const typed = action as ActionFromDefs<D>
	if (app.engine.allows && !app.engine.allows(state, actor, typed)) {
		return { ok: false, error: `not allowed: ${action.type}` }
	}
	const next = app.engine.step(state, typed, actor)
	const v = view(app, next, actor)
	const result: DispatchOk<S, V> = { ok: true, prev: state, next, view: v }
	if (app.agent?.narrate) {
		result.narration = app.agent.narrate({ prev: state, next, action: typed, actor }, v)
	}
	if (app.engine.availableActions) {
		result.availableActions = app.engine.availableActions(next, actor) as readonly Action[]
	}
	return result
}

export function view<S, D extends ActionDefs, TActor extends Actor, V>(
	app: App<S, D, TActor, V>,
	state: S,
	actor: TActor
): V {
	return app.engine.view ? app.engine.view(state, actor) : (state as unknown as V)
}

export function tools<S, D extends ActionDefs, TActor extends Actor, V>(
	app: App<S, D, TActor, V>
): ToolDescriptor[] {
	return Object.entries(app.engine.actions).map(([name, def]) => ({
		name,
		description: def.description,
		parameters: def.schema
	}))
}

export function availableActions<S, D extends ActionDefs, TActor extends Actor, V>(
	app: App<S, D, TActor, V>,
	state: S,
	actor: TActor
): readonly Action[] | null {
	return app.engine.availableActions
		? (app.engine.availableActions(state, actor) as readonly Action[])
		: null
}

export function done<S, D extends ActionDefs, TActor extends Actor, V>(
	app: App<S, D, TActor, V>,
	state: S
): boolean {
	return app.done ? app.done(state) : false
}

export function briefing<S, D extends ActionDefs, TActor extends Actor, V>(
	app: App<S, D, TActor, V>
): string | null {
	return app.agent?.briefing ?? null
}
