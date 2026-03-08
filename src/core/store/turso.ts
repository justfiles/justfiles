import type { Client } from '@libsql/client'
import { createClient } from '@libsql/client/web'
import type { EmbeddingProvider } from '../embedding'
import type { QueryExpander } from '../llm'
import type { Store } from './types'
import { createLibsqlAdapter } from './db-adapter'
import { migrate as runMigrate, createStore } from './store-impl'

// Run DB migrations via the libsql client.
// Call this once at startup from Bun/Node environments before creating the store.
// In CF Workers, run migrations via wrangler or an external migration tool instead.
async function migrate(client: Client): Promise<void> {
	return runMigrate(createLibsqlAdapter(client))
}

export async function tursoStore(
	user: { id: string; token: string },
	embProvider?: EmbeddingProvider,
	queryExpander?: QueryExpander
): Promise<Store> {
	// const url = `libsql://default-xiaoxinghu.aws-ap-northeast-1.turso.io`
	const url = `libsql://${user.id}-xiaoxinghu.aws-ap-northeast-1.turso.io`
	const authToken = user.token
	const client = createClient({ url, authToken })
	// await migrate(client)
	return createStore(createLibsqlAdapter(client), embProvider, queryExpander)
}
