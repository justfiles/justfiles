import { hc } from 'hono/client'
import type { WorkerApiType } from '@ghostore/worker/api-types'
import type { Config } from './config.ts'

export function makeClient(cfg: Config) {
	if (!cfg.key) throw new Error(
		'API key is required. Set it using one of:\n' +
		'  1. Config file (~/.config/ghostore/config.json or ~/.ghostore.json):\n' +
		'       { "key": "your-api-key" }\n' +
		'  2. Environment variable: GHOSTORE_API_KEY=your-api-key\n' +
		'  3. Flag: --key your-api-key'
	)
	return hc<WorkerApiType>(cfg.url, {
		headers: { Authorization: `Bearer ${cfg.key}` },
	})
}
