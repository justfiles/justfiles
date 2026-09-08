// The provider registry types — the one pluggable unit of the accounts model. A
// Provider bundles how to CONNECT an account (`auth`: an interactive flow, a
// credentials form, or nothing) with how to USE one (`capabilities.<kind>.bind`:
// stored creds → a live capability impl). Providers are constructed per platform —
// the constructor closes over whatever differs there (an AuthFlow, OAuth client
// creds, the platform LLM) — and handed to `hostAccounts` (host.ts), which
// is generic over them: the host never names a provider.

import type { AiCapability } from '../ai/index.ts'
import type { CalendarCapability } from '../calendar/index.ts'
import type { EmailCapability } from '../email/index.ts'
import type { ImageCapability } from '../image/index.ts'
import type { CredentialsSchema, SignInPrompt } from './contract.ts'

// Platform seam for interactive (delegated) auth: the provider hands over a URL
// builder, the platform picks the redirect URI it can catch (an ephemeral loopback
// port, a web route, an app scheme), sends the user to the built URL, and resolves
// with the full callback URL — query params included — once the redirect lands.
// Protocol logic (PKCE, state, token exchange) stays with the provider.
export interface AuthFlow {
	authorize(
		buildUrl: (redirectUri: string) => string,
		opts?: { signal?: AbortSignal }
	): Promise<URL>
}

// What `acquire` yields: a verified account identity plus the creds to store.
// `scopes` records what was actually granted (drives incremental consent).
export interface AcquiredAccount {
	accountId: string
	creds: unknown
	scopes?: string[]
}

// How an account is connected: a UI hint (what Settings renders — a form, a
// "Sign in…" button, or nothing for a builtin) plus the one acquisition verb.
// A new protocol (device grant, …) is a new `acquire` implementation, not a new kind.
export interface Auth {
	ui: { kind: 'form'; schema: CredentialsSchema } | { kind: 'interactive' } | { kind: 'none' }
	acquire(input: {
		fields?: Record<string, string>
		scopes: string[]
		signal?: AbortSignal
		notify?: (prompt: SignInPrompt) => void
	}): Promise<AcquiredAccount>
}

// A stored account as handed to `bind`. `creds` are opaque to everything but the
// owning provider; `persist` writes rotated creds back to the store (a provider
// whose tokens refresh mid-use MUST call it, or a later mint reuses a consumed
// grant). `config` carries per-capability settings (e.g. `{ model }` for ai).
export interface CredentialAccess {
	read(): Promise<unknown>
	modify(change: (creds: unknown) => Promise<unknown>): Promise<unknown>
}

export interface BoundAccount {
	credentials: CredentialAccess
	creds: unknown
	config?: unknown
	persist(creds: unknown): Promise<void>
}

// One capability a provider can back: the (oauth) scope the account must have
// granted — omitted = granted by the account existing — and the impl factory.
export interface Binding<T> {
	scope?: string
	bind(account: BoundAccount): T
}

export interface AiModel {
	id: string
	name: string
}

export interface Provider {
	id: string
	name: string
	// Platform-managed (the built-in AI): Settings offers no connect/disconnect, only toggles.
	builtin?: boolean
	auth: Auth
	capabilities: {
		email?: Binding<EmailCapability>
		calendar?: Binding<CalendarCapability>
		// ai optionally carries a model catalogue for the Settings picker.
		ai?: Binding<AiCapability> & { models?(): AiModel[]; defaultModel?(): string }
		// Image generation uses its own provider, independent of the text selection.
		image?: Binding<ImageCapability>
	}
}
