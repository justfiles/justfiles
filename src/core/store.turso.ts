import { createClient } from '@libsql/client/web'
import type { EmbeddingProvider } from './embedding'
import type { LLM } from './llm'
import type { Reranker } from './reranker'
import type { Store } from './store'
import { createLibsqlAdapter } from './db.libsql'
import { createStore } from './store'

export async function tursoStore(
	user: { id: string; token: string },
	embProvider?: EmbeddingProvider,
	llm?: LLM,
	reranker?: Reranker
): Promise<Store> {
	const url = `libsql://${user.id}-xiaoxinghu.aws-ap-northeast-1.turso.io`
	const client = createClient({ url, authToken: user.token })
	// await migrate(client)
	return createStore(createLibsqlAdapter(client), embProvider, llm, reranker)
}
