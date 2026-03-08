import { createClient } from '@libsql/client/web'
import type { EmbeddingProvider } from '../embedding'
import type { QueryExpander } from '../llm'
import type { Store } from './types'
import { createLibsqlAdapter } from './db-adapter'
import { createStore } from './store-impl'

export async function tursoStore(
	user: { id: string; token: string },
	embProvider?: EmbeddingProvider,
	queryExpander?: QueryExpander
): Promise<Store> {
	// const url = `libsql://default-xiaoxinghu.aws-ap-northeast-1.turso.io`
	const url = `libsql://${user.id}-xiaoxinghu.aws-ap-northeast-1.turso.io`
	const client = createClient({ url, authToken: token })
	// await migrate(client)
	return createStore(createLibsqlAdapter(client), embProvider, queryExpander)
}
