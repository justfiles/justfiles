import { DurableObject } from 'cloudflare:workers'
import { migrate } from 'drizzle-orm/durable-sqlite/migrator'
import migrations from '../../drizzle/migrations'
import { createApi } from '../core/api'
import { getStore } from '../core/store'
import { fromDO } from '../db/do'

export class MemoryObject extends DurableObject<Env> {
	private readonly app: ReturnType<typeof createApi>

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		const db = fromDO(ctx.storage)
		ctx.blockConcurrencyWhile(async () => {
			migrate(db, migrations)
		})
		this.app = createApi(getStore(db))
	}

	fetch(request: Request) {
		return this.app.fetch(request)
	}
}
