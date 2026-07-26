import { implementCapability } from '../implement.ts'
import type { Capability } from '../types.ts'
import type { UserProfile } from './contract.ts'
import { user } from './index.ts'

// Where the host reads identity from: Clerk in the frieren browser, the native
// account in the Mac app (null until that lands). Kept as a thunk so the impl always
// reflects the CURRENT session — a sign-in/out is picked up on the next call.
export type GetUser = () => UserProfile | null | Promise<UserProfile | null>

// Host implementation of `user`. Served locally (identity lives where the session
// does), so it needs no network and works offline.
export function userCapability(getUser: GetUser): Capability {
	return implementCapability(user, {
		current: async () => (await getUser()) ?? null
	})
}
