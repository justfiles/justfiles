import { DurableObject } from 'cloudflare:workers'
import {
	createDoAdapter,
	createDoSyncDb,
	migrateSqlite,
	migrateSync,
	scopedBlobs,
	sqliteStore
} from '@justfiles/core'
import { coreMigrations } from '@justfiles/core/migrations'
import { authority } from '@justfiles/fs/authority'
import { syncStateLock } from '@justfiles/fs/peer'
import { createWorkerApiApp, type WorkerApiType } from './app'

/**
 * Where the one-time pass from the old tables to the store model is recorded.
 *
 * Durable and outside SQLite on purpose: the pass is idempotent and resumable, so a
 * crash before this lands costs a re-read and nothing else — but a pass that ran AGAIN
 * after clients started writing would copy stale rows over live ones, since rule 3 only
 * makes an IDENTICAL row a no-op. Everything between the migration and this marker runs
 * inside `blockConcurrencyWhile`, so no request is served in that window.
 */
const ADOPTED_KEY = 'store:adopted'

export class MemoryObject extends DurableObject<Env> {
	private readonly app: WorkerApiType

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		// ctx.id.name is unreliable in local dev (Miniflare) — ctx.id.toString() is always
		// stable and unique, and it is what scopes this object's objects in the bucket.
		const namespace = ctx.id.toString()
		// Bytes too big for a row go to R2: a Workers SQLite ROW is capped at 2 MB — hard
		// — so a store that inlined everything could not hold a larger file at all.
		const lock = syncStateLock()
		const store = sqliteStore(createDoSyncDb(ctx.storage), undefined, {
			lock,
			blobs: scopedBlobs(env.ASSETS, namespace)
		})
		// Every served path goes through the authority: rule 9's invariants, one commit at
		// a time, and a hash this server verifies rather than takes a peer's word for.
		const tree = authority(store)
		this.app = createWorkerApiApp({ store: tree, receiver: { lock } })
		// The one initialization seam: no request runs until the schema exists and the old
		// tree has been adopted, so nothing else needs a readiness gate. The pass writes
		// into the RAW store, past the authority — nothing else is running, the rows come
		// out of this same database rather than off a wire, and every parent is written
		// before its children, so rule 9 holds by construction.
		ctx.blockConcurrencyWhile(async () => {
			// Synchronous, so each migration's statements and its `schema_migrations` record
			// commit together — an interrupted one that half-applied would brick every later
			// one (a re-run `ALTER TABLE ADD COLUMN` failing as a duplicate).
			migrateSync(createDoSyncDb(ctx.storage), coreMigrations)
			if (await ctx.storage.get(ADOPTED_KEY)) return
			await migrateSqlite(createDoAdapter(ctx.storage), store, { blobs: env.ASSETS })
			await ctx.storage.put(ADOPTED_KEY, true)
		})
	}

	async fetch(request: Request): Promise<Response> {
		return this.app.fetch(request)
	}
}
