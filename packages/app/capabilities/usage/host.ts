import { implementCapability } from '../implement.ts'
import type { Capability } from '../types.ts'
import type { UsageSnapshot } from './contract.ts'
import { usage } from './index.ts'

// Where the host reads usage from: the frieren DO's per-user meter + quota. Kept as a
// thunk so every call reflects the CURRENT counters. Served locally (usage lives where
// the account does), so it needs no extra network hop.
export type GetUsage = () => UsageSnapshot | Promise<UsageSnapshot>

export function usageCapability(getUsage: GetUsage): Capability {
	return implementCapability(usage, {
		current: async () => getUsage()
	})
}
