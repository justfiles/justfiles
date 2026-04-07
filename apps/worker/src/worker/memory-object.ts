import { DurableObject } from 'cloudflare:workers'
import { googleReranker, openAIEmbedding, openAILlm, type Store } from '@ghostore/core'
import { VectorizeVectorStore } from '../core/vector.vectorize'
import { createWorkerApiApp, type WorkerApiType } from './app'
import { cfFsStorage, cfStore, migrateCF } from './db.do'

export class MemoryObject extends DurableObject<Env> {
	private readonly app: WorkerApiType
	private readonly store: Store

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		ctx.blockConcurrencyWhile(() => migrateCF(ctx.storage))
		const env_ = env as typeof env & { GOOGLE_PROJECT_ID?: string; GOOGLE_SA_KEY?: string }
		const reranker =
			env_.GOOGLE_PROJECT_ID && env_.GOOGLE_SA_KEY
				? googleReranker(
						env_.GOOGLE_PROJECT_ID,
						JSON.parse(env_.GOOGLE_SA_KEY) as { client_email: string; private_key: string }
					)
				: undefined
		// ctx.id.name is unreliable in local dev (Miniflare) — ctx.id.toString() is always stable and unique
		const namespace = ctx.id.toString()
		const vectorStore = new VectorizeVectorStore(env.VECTORIZE)
		const store = cfStore(
			ctx.storage,
			namespace,
			openAIEmbedding(env.OPENAI_KEY),
			openAILlm(env.OPENAI_KEY),
			reranker,
			vectorStore
		)
		store.onUpdate(async () => {
			const existing = await ctx.storage.getAlarm()
			if (existing == null || existing <= Date.now()) {
				await ctx.storage.setAlarm(Date.now() + 10_000)
			}
		})
		const fs = cfFsStorage(ctx.storage, namespace, env.ASSETS)
		this.store = store
		this.app = createWorkerApiApp({ store, fs })
	}

	async fetch(request: Request): Promise<Response> {
		return this.app.fetch(request)
	}

	async alarm(): Promise<void> {
		const hasMore = await this.store.processEmbedding()
		if (hasMore) {
			await this.ctx.storage.setAlarm(Date.now() + 5_000)
		}
		await this.store.purgeExpired()
	}
}
