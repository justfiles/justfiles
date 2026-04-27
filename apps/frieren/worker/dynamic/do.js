// @ts-check
import { DurableObject } from 'cloudflare:workers'
import { app } from './app.js'

/** @import { Action, Actor } from '../../apps/engine' */

/**
 * @typedef {{ name: string, description?: string, parameters: unknown }} ToolDescriptor
 * @typedef {{ ok: true, view: unknown, narration?: string | null, availableActions?: readonly Action[] } | { ok: false, error: string }} DispatchResult
 */

const STATE_KEY = 'state'

export class App extends DurableObject {
	/** @returns {unknown} */
	#state() {
		return this.ctx.storage.kv.get(STATE_KEY) ?? app.engine.initial
	}

	/**
	 * @param {Action} action
	 * @param {Actor} actor
	 * @returns {Promise<DispatchResult>}
	 */
	async dispatch(action, actor) {
		const engine = app.engine
		if (!engine.actions[action.type]) return { ok: false, error: `unknown action: ${action.type}` }
		const prev = this.#state()
		if (engine.allows && !engine.allows(prev, actor, action)) {
			return { ok: false, error: `not allowed: ${action.type}` }
		}
		const next = engine.step(prev, action, actor)
		this.ctx.storage.kv.put(STATE_KEY, next)
		const view = engine.view ? engine.view(next, actor) : next
		/** @type {DispatchResult} */
		const result = { ok: true, view }
		if (app.agent?.narrate) {
			result.narration = app.agent.narrate({ prev, next, action, actor }, view)
		}
		if (engine.availableActions) result.availableActions = engine.availableActions(next, actor)
		return result
	}

	/** @param {Actor} actor */
	async view(actor) {
		const engine = app.engine
		const state = this.#state()
		return engine.view ? engine.view(state, actor) : state
	}

	/**
	 * @param {Actor} actor
	 * @param {Action} action
	 */
	async allows(actor, action) {
		const engine = app.engine
		const state = this.#state()
		return engine.allows ? engine.allows(state, actor, action) : true
	}

	/** @param {Actor} actor */
	async availableActions(actor) {
		const engine = app.engine
		const state = this.#state()
		return engine.availableActions ? engine.availableActions(state, actor) : null
	}

	/** @returns {Promise<ToolDescriptor[]>} */
	async tools() {
		return Object.entries(app.engine.actions).map(([name, def]) => ({
			name,
			description: def.description,
			parameters: def.schema
		}))
	}

	async briefing() {
		return app.agent?.briefing ?? null
	}

	async done() {
		return app.done ? app.done(this.#state()) : false
	}
}
