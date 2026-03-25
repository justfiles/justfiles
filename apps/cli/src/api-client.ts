import type { WorkerApiType } from '@ghostore/worker/api-types'
import { hc } from 'hono/client'

export type GhostoreApiClient = ReturnType<typeof hc<WorkerApiType>>

export function createApiClient(baseUrl: string, apiKey: string): GhostoreApiClient {
	return hc<WorkerApiType>(baseUrl, {
		headers: {
			Authorization: `Bearer ${apiKey}`
		}
	})
}
