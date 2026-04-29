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
	/** @returns {import('@justfiles/app').Snapshot} */
	#state() {
		const saved = this.ctx.storage.kv.get(STATE_KEY)
		if (isSnapshot(saved)) return saved
		const fresh = initial(app)
		this.ctx.storage.kv.put(STATE_KEY, fresh)
		return fresh
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
		return allows(app, this.#state(), actor, action)
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
