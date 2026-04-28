// @ts-check
//
// Dynamic-worker DO: thin RPC wrapper around the shared @justfiles/app runtime.
// Persistence (CF storage.kv) lives here; everything else is delegated.

import { DurableObject } from 'cloudflare:workers'
import app from './app.js'
import { availableActions, briefing, dispatch, done, tools, view } from './runtime.js'

/** @import { Action, Actor } from '@justfiles/app' */

const STATE_KEY = 'state'

export class App extends DurableObject {
	#state() {
		return this.ctx.storage.kv.get(STATE_KEY) ?? app.engine.initial
	}

	/**
	 * @param {Action} action
	 * @param {Actor} actor
	 */
	async dispatch(action, actor) {
		const result = dispatch(app, this.#state(), action, actor)
		if (result.ok) this.ctx.storage.kv.put(STATE_KEY, result.next)
		return result
	}

	/** @param {Actor} actor */
	async view(actor) {
		return view(app, this.#state(), actor)
	}

	/**
	 * @param {Actor} actor
	 * @param {Action} action
	 */
	async allows(actor, action) {
		return app.engine.allows ? app.engine.allows(this.#state(), actor, action) : true
	}

	/** @param {Actor} actor */
	async availableActions(actor) {
		return availableActions(app, this.#state(), actor)
	}

	async tools() {
		return tools(app)
	}

	async briefing() {
		return briefing(app)
	}

	async done() {
		return done(app, this.#state())
	}
}
