export type CapabilityId = 'email' | 'calendar' | 'ai' | 'image'

export interface ConnectRef {
	providerId: string
	operationId: string
}

export interface SignInPrompt {
	verificationUrl: string
	userCode?: string
	intervalMs?: number
}

export type ConnectState = ConnectRef & { expiresAt: number } & (
		| { status: 'pending'; prompt?: SignInPrompt }
		| { status: 'connected'; accountId: string }
		| { status: 'cancelled' | 'expired' }
		| { status: 'failed'; message: string }
	)

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

// Account administration is called by the host UI.
export interface AccountsAdmin {
	beginConnect(input: ConnectRef & { method?: 'browser' | 'device_code' }): Promise<ConnectState>
	completeConnect(input: ConnectRef & { callbackUrl: string }): Promise<ConnectState>
	readConnect(input: ConnectRef): Promise<ConnectState>
	cancelConnect(input: ConnectRef): Promise<void>
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
