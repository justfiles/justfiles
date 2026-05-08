// @ts-check
//
// Dynamic-worker DO: thin RPC wrapper around the shared @justfiles/app
// Runner. Persistence (CF storage.kv) lives here as a storage adapter;
// everything else (pure dispatch, invoke lifecycle, stale guards, abort,
// task execution) is delegated to the runner.

import { DurableObject } from 'cloudflare:workers'
import app from './app.js'
import { bindCapabilities } from './capabilities-bridge.js'
import { Runner } from './runner.js'

/** @import { Action, Actor, Snapshot } from '@justfiles/app' */
/** @import { CapabilityBridge } from '@justfiles/app/capabilities-bridge.js' */

const STATE_KEY = 'state'

export class App extends DurableObject {
	#runner
	#ready

	/**
	 * @param {DurableObjectState} ctx
	 * @param {Env & { APP_BRIDGE?: CapabilityBridge }} env
	 */
	constructor(ctx, env) {
		super(ctx, env)
		const storage = {
			/** @returns {Promise<Snapshot | undefined>} */
			load: async () => {
				const saved = await this.ctx.storage.kv.get(STATE_KEY)
				return isSnapshot(saved) ? saved : undefined
			},
			/** @param {Snapshot} snapshot */
			save: async (snapshot) => {
				await this.ctx.storage.kv.put(STATE_KEY, snapshot)
			}
		}
		const bridge = env.APP_BRIDGE
		const instances = app.engine.capabilities ?? []
		this.#runner = new Runner({
			app,
			storage,
			// `meta` is ignored for now; #64 will let the broker tag audit
			// logs by task run. Without a bridge (no capabilities declared or
			// host did not wire one) handlers see `capabilities: {}`.
			host: (_meta) => ({
				capabilities: bridge ? bindCapabilities(bridge, instances) : {}
			})
		})
		this.#ready = this.#runner.start()
	}

	async #r() {
		await this.#ready
		return this.#runner
	}

	/**
	 * @param {Action} action
	 * @param {Actor} actor
	 */
	async dispatch(action, actor) {
		const r = await this.#r()
		return r.dispatch(action, actor)
	}

	/** @param {Actor} actor */
	async view(actor) {
		const r = await this.#r()
		return r.view(actor)
	}

	/**
	 * @param {Actor} actor
	 * @param {Action} action
	 */
	async allows(actor, action) {
		const r = await this.#r()
		return r.allows(actor, action)
	}

	/** @param {Actor} actor */
	async availableActions(actor) {
		const r = await this.#r()
		return r.availableActions(actor)
	}

	async reset() {
		const r = await this.#r()
		return r.reset()
	}

	/** @param {Actor=} actor */
	async tools(actor) {
		const r = await this.#r()
		return r.tools(actor)
	}

	async briefing() {
		const r = await this.#r()
		return r.briefing()
	}

	async done() {
		const r = await this.#r()
		return r.done()
	}
}

/**
 * @param {unknown} value
 * @returns {value is Snapshot}
 */
function isSnapshot(value) {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (/** @type {{ state?: unknown }} */ (value).state) === 'string' &&
		'context' in value
	)
}
