import { DurableObject } from 'cloudflare:workers'
import { Hono } from 'hono'
import { createApi } from '../core/api'
import { openAI } from '../core/embedding.openai'
import { cfStore, migrateCF } from './store'

export class MemoryObject extends DurableObject<Env> {
	private readonly app: Hono

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		ctx.blockConcurrencyWhile(() => migrateCF(ctx.storage))
		const app = new Hono()
		app.route('/api', createApi(cfStore(ctx.storage, openAI(env.OPENAI_KEY))))
		this.app = app
	}

	async fetch(request: Request): Promise<Response> {
		return this.app.fetch(request)
	}
}
