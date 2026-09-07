// The accounts model's ADMIN surface and its UI projections. The user connects a
// provider account once, then toggles which capabilities (email/calendar/ai) that
// account backs — the macOS "Internet Accounts" shape. The use facets are separate
// capabilities (`email`/`calendar`/`ai`) any app may call; administration is NOT a
// capability of its own — it reaches apps only through `settings` (`accounts.*`),
// which is gated on first-party app identity. No Cloudflare imports, no provider
// clients — app-safe.

export type CapabilityId = 'email' | 'calendar' | 'ai' | 'image'

export interface CredentialField {
	type: 'string'
	minLength?: number
	description?: string
}

export interface CredentialsSchema {
	type: 'object'
	properties: Record<string, CredentialField>
	required?: string[]
}

// A connectable provider, projected for the UI. No host internals (no bind
// factories, no auth flows) ever reach the app. `authKind` is the acquisition
// interaction Settings must render: a credentials form, an interactive
// (delegated) sign-in, or nothing (platform-managed).
export interface ProviderInfo {
	id: string
	name: string
	authKind: 'form' | 'interactive' | 'none'
	// Platform-managed (e.g. the built-in AI): the UI offers no connect/disconnect, only its
	// capability toggles.
	builtin?: boolean
	// Capabilities an account from this provider can back.
	capabilities: CapabilityId[]
	// Present iff authKind === 'form' — the fields the connect form renders.
	credentialsSchema?: CredentialsSchema
}

// Who acquired this account's credential — the only thing D1/D2 ("one account, many
// hosts", #290) let a device read without holding the bytes. The DO is always
// `cloud`; a device that connected an account directly (e.g. the mac daemon) is
// `device`, labelled for display (a hostname) — not a boolean, so a third owner
// never needs a breaking change. Optional: an older host that hasn't deployed this
// field omits it, and a reader treats that as `cloud`.
export type AccountOrigin = { kind: 'cloud' } | { kind: 'device'; label: string }

// A connected account, projected for the UI. NEVER carries credentials.
export interface AccountInfo {
	accountId: string
	providerId: string
	enabled: CapabilityId[]
	// Per-capability settings the UI renders (e.g. ai → selected + available
	// models). Opaque to the contract; the provider/host shapes it.
	config: Partial<Record<CapabilityId, unknown>>
	lastError?: string
	origin?: AccountOrigin
}

// The admin methods, as `hostAccounts` hands them to `settingsHost`. Not a
// capability: a plain impl, so composing it needs no second contract.
export interface AccountsAdmin {
	listProviders(input: Record<string, never>): Promise<ProviderInfo[]>
	listAccounts(input: Record<string, never>): Promise<AccountInfo[]>
	// `form` providers: pass `credentials`. `interactive` providers: omit — the host
	// runs the flow (opens the browser, catches the redirect) and derives `accountId`
	// from the verified identity.
	connect(input: { providerId: string; credentials?: Record<string, string> }): Promise<{
		accountId: string
	}>
	// The macOS "service" checkbox. `config` sets per-capability settings (e.g. the
	// ai model) and is preserved across a re-enable when omitted.
	setEnabled(input: {
		accountId: string
		capability: CapabilityId
		enabled: boolean
		config?: unknown
	}): Promise<void>
	disconnect(input: { accountId: string }): Promise<void>
}
