/// <reference path="./migrations.d.ts" />

import { DurableObject } from 'cloudflare:workers'
import { migrate } from 'drizzle-orm/durable-sqlite/migrator'
import migrations from '../../drizzle/migrations.js'
import { createApi } from '../core/api'
import { openAI } from '../core/embedding.openai'
import { getStore } from '../core/store'
import { VectorizeVectorStore } from '../core/vector.vectorize'
import { fromDO } from '../db/do'

export class MemoryObject extends DurableObject<Env> {
	private readonly app: ReturnType<typeof createApi>

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		const db = fromDO(ctx.storage)
		ctx.blockConcurrencyWhile(async () => {
			migrate(db, migrations)
		})
		const vectorStore = new VectorizeVectorStore(env.VECTORIZE, this.ctx.id.toString())
		this.app = createApi(getStore(db, openAI(env.OPENAI_KEY), vectorStore))
	}

	async fetch(request: Request) {
		const url = new URL(request.url)
		if (request.method === 'GET' && url.pathname.endsWith('/v1/export')) {
			const rows = this.ctx.storage.sql.exec('SELECT * FROM chunks').toArray()
			return new Response(JSON.stringify(rows, null, 2), {
				headers: {
					'Content-Type': 'application/json',
					'Content-Disposition': 'attachment; filename="memories.json"'
				}
			})
		}
		return this.app.fetch(request)
	}
}
