// @ts-check
//
// Dynamic-worker DO: thin RPC wrapper around the shared @justfiles/app
// Runner. Persistence (CF storage.kv) lives here as a storage adapter;
// everything else (pure dispatch, invoke lifecycle, stale guards, abort,
// task execution) is delegated to the runner.

import { DurableObject } from 'cloudflare:workers'
import app from './app.js'
import { Runner } from './runner.js'

/** @import { Action, Actor, RunnerState } from '@justfiles/app' */

const STATE_KEY = 'state'

export class App extends DurableObject {
	#runner
	#ready

	/**
	 * @param {DurableObjectState} ctx
	 * @param {Env} env
	 */
	constructor(ctx, env) {
		super(ctx, env)
		const storage = {
			/** @returns {Promise<RunnerState | undefined>} */
			load: async () => {
				const saved = await this.ctx.storage.kv.get(STATE_KEY)
				return isRunnerState(saved) ? saved : undefined
			},
			/** @param {RunnerState} state */
			save: async (state) => {
				await this.ctx.storage.kv.put(STATE_KEY, state)
			}
		}
		this.#runner = new Runner({
			app,
			storage,
			// #59 will inject capability bridge here from this.env.
			host: () => ({})
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
 * @returns {value is RunnerState}
 */
function isRunnerState(value) {
	if (typeof value !== 'object' || value === null) return false
	const v = /** @type {{ snapshot?: unknown }} */ (value)
	const s = v.snapshot
	return (
		typeof s === 'object' &&
		s !== null &&
		typeof (/** @type {{ state?: unknown }} */ (s).state) === 'string' &&
		'context' in s
	)
}
