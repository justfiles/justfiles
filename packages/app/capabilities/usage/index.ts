import { defineCapability } from '../core.ts'
import type { UsageCapability } from './contract.ts'

export type { UsageCapability, UsageResource, UsageSnapshot } from './contract.ts'

// The `usage` capability — one read facet. Declared with no scope: reading your own
// metered usage is unprivileged (it's not a credential), so any app may call it, like
// a system framework.
export const usage = defineCapability<'usage', UsageCapability>('usage')
