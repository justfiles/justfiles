import { hc } from 'hono/client'
import type { WorkerApiType } from '@ghostore/worker/api-types'
import type { Config } from './config.ts'

export function makeClient(cfg: Config) {
	if (!cfg.key) throw new Error('API key is required. Set GHOSTORE_API_KEY or use --key.')
	return hc<WorkerApiType>(cfg.url, {
		headers: { Authorization: `Bearer ${cfg.key}` },
	})
}
