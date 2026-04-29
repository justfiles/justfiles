// @ts-check
//
// Dynamic-worker DO: thin RPC wrapper around the shared @justfiles/app runtime.
// Persistence (CF storage.kv) lives here; everything else is delegated.

import { DurableObject } from 'cloudflare:workers'
import app from './app.js'
import {
	allows,
	availableActions,
	briefing,
	dispatch,
	done,
	initial,
	tools,
	view
} from './runtime.js'

/** @import { Action, Actor } from '@justfiles/app' */

const STATE_KEY = 'state'

export class App extends DurableObject {
	/** @returns {Promise<import('@justfiles/app').Snapshot>} */
	async #state() {
		const saved = await this.ctx.storage.kv.get(STATE_KEY)
		if (isSnapshot(saved)) return saved
		const fresh = initial(app)
		await this.ctx.storage.kv.put(STATE_KEY, fresh)
		return fresh
	}

	/**
	 * @param {Action} action
	 * @param {Actor} actor
	 */
	async dispatch(action, actor) {
		const result = dispatch(app, await this.#state(), action, actor)
		if (result.ok) await this.ctx.storage.kv.put(STATE_KEY, result.next)
		return result
	}

	/** @param {Actor} actor */
	async view(actor) {
		return view(app, await this.#state(), actor)
	}

	/**
	 * @param {Actor} actor
	 * @param {Action} action
	 */
	async allows(actor, action) {
		return allows(app, await this.#state(), actor, action)
	}

	/** @param {Actor} actor */
	async availableActions(actor) {
		return availableActions(app, await this.#state(), actor)
	}

	/** @returns {Promise<import('@justfiles/app').Snapshot>} */
	async reset() {
		const fresh = initial(app)
		await this.ctx.storage.kv.put(STATE_KEY, fresh)
		return fresh
	}

	async tools() {
		return tools(app)
	}

	async briefing() {
		return briefing(app)
	}

	async done() {
		return done(app, await this.#state())
	}
}

/**
 * @param {unknown} value
 * @returns {value is import('@justfiles/app').Snapshot}
 */
function isSnapshot(value) {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (/** @type {{ state?: unknown }} */ (value).state) === 'string' &&
		'context' in value
	)
}
