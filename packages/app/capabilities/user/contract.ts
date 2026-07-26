// The signed-in user's basic identity — a read-only "who am I" use facet any app
// may call. Distinct from `accounts` (connected third-party providers): this is the
// person using the OS, surfaced so an app (Settings first) can render their name and
// avatar. Progressive by design — grow `UserProfile` with optional fields; the one
// method never changes.

export interface UserProfile {
	// Stable account identifier (Clerk user id in frieren; the native account later).
	id: string
	name?: string
	avatarUrl?: string
}

export interface UserCapability {
	// The current user, or null when no one is signed in (the Mac app before native
	// auth; a signed-out web session).
	current(input: Record<string, never>): Promise<UserProfile | null>
}
