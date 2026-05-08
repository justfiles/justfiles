// Cloudflare-side adapter that wraps the platform-agnostic capability broker
// (`@justfiles/app/capabilities/broker`) so a host can pass it into a dynamic
// worker via `WorkerLoaderWorkerCode.env`. The dynamic-worker sandbox reads
// the stub from `env.APP_BRIDGE` and routes typed
// `ctx.capabilities.<id>.<method>(...)` calls through it via
// `bindCapabilities` (from `@justfiles/app/capabilities-bridge`).

import { RpcTarget } from 'cloudflare:workers'
import type { CapabilityBridge } from '@justfiles/app/capabilities-bridge.js'

export {
	type AppFacetScope,
	appLoaderCacheKey,
	type CapabilityGrant,
	grantsHash
} from './app-loader-key'

export class AppBridge extends RpcTarget {
	#bridge: CapabilityBridge
	constructor(bridge: CapabilityBridge) {
		super()
		this.#bridge = bridge
	}
	async invoke(req: { capability: string; method: string; input: unknown }): Promise<unknown> {
		return this.#bridge.invoke(req)
	}
}
