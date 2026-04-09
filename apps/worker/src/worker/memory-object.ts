import { DurableObject } from 'cloudflare:workers'
import { createWorkerApiApp, type WorkerApiType } from './app'
import { cfFsStorage, migrateCF } from './db.do'

export class MemoryObject extends DurableObject<Env> {
	private readonly app: WorkerApiType

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		ctx.blockConcurrencyWhile(() => migrateCF(ctx.storage))
		// ctx.id.name is unreliable in local dev (Miniflare) — ctx.id.toString() is always stable and unique
		const namespace = ctx.id.toString()
		const fs = cfFsStorage(ctx.storage, namespace, env.ASSETS)
		this.app = createWorkerApiApp({ fs })
	}

	async fetch(request: Request): Promise<Response> {
		return this.app.fetch(request)
	}
}
