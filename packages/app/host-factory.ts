// Constructs a fresh `Host` per app mount. Per-mount state (later slices:
// agent.describe callback, registered tools) lives on the instance so it
// cannot leak across slot swaps.

import { APP_CONTRACT_VERSION, type Host } from './contract.js'

export function createHost(): Host {
	return Object.freeze({ version: APP_CONTRACT_VERSION })
}
