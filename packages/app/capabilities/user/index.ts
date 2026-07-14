import { defineCapability } from '../core.ts'
import type { UserCapability } from './contract.ts'

export type { UserCapability, UserProfile } from './contract.ts'

// The `user` capability — one read facet. Declared with no scope: reading the
// signed-in user's basic profile is unprivileged (it's not a credential), so any
// app may call it, like a system framework.
export const user = defineCapability<'user', UserCapability>('user')
