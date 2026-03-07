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
	private readonly appByTenant = new Map<string, ReturnType<typeof createApi>>()
	private readonly db: ReturnType<typeof fromDO>
	private readonly embProvider: ReturnType<typeof openAI>
	private readonly vectorIndex: Env['VECTORIZE']

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		this.db = fromDO(ctx.storage)
		this.embProvider = openAI(env.OPENAI_KEY)
		this.vectorIndex = env.VECTORIZE
		ctx.blockConcurrencyWhile(async () => {
			migrate(this.db, migrations)
		})
	}

	private getTenantIdFromRequest(request: Request): string {
		return request.headers.get('X-Tenant-Id') ?? this.ctx.id.toString()
	}

	private getAppForTenant(tenantId: string): ReturnType<typeof createApi> {
		let app = this.appByTenant.get(tenantId)
		if (app) return app

		const vectorStore = new VectorizeVectorStore(this.vectorIndex, tenantId)
		const store = getStore(this.db, this.embProvider, vectorStore)
		app = createApi(store)
		this.appByTenant.set(tenantId, app)
		return app
	}

	async fetch(request: Request) {
		const tenant = this.getTenantIdFromRequest(request)
		const app = this.getAppForTenant(tenant)
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
		return app.fetch(request)
	}
}
