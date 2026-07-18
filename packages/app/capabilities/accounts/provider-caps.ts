// The provider catalog: the single, static source of truth for what each provider
// kind is — its display name, auth kind, the capabilities it can back, and (for oauth
// kinds) the scope each capability needs. This is CODE, never per-user state — the
// analog of a Composio Auth Config or Arcade's per-tool scopes.
//
// Capability availability is DERIVED from a connection's kind + granted scopes via
// `backs()`; there is no persisted capability→connection table. The one thing that
// can't be derived — which connection is the single active AI — lives in active-ai.ts.

import type { Connection } from './connection.ts'
import type { CapabilityId, CredentialsSchema } from './contract.ts'

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify'
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'

const ICLOUD_SCHEMA: CredentialsSchema = {
	type: 'object',
	properties: {
		username: {
			type: 'string',
			minLength: 1,
			description: 'Apple ID email address used to sign into iCloud.'
		},
		password: {
			type: 'string',
			minLength: 1,
			description:
				'App-specific password generated at appleid.apple.com → Sign-In and Security → App-Specific Passwords. Not your Apple ID password.'
		}
	},
	required: ['username', 'password']
}

export interface ProviderCatalogEntry {
	name: string
	authKind: 'form' | 'oauth'
	// Platform-managed (Spud AI): the UI offers no connect/disconnect, only toggles.
	builtin?: boolean
	// Present iff authKind === 'form' — the fields the connect form renders.
	credentialsSchema?: CredentialsSchema
	// Capabilities this kind can back, and (oauth) the scope each needs. A capability
	// with no `scope` is granted by the connection simply existing — form providers
	// (iCloud), and ai (whose single-active selection lives in active-ai.ts).
	caps: { capability: CapabilityId; scope?: string }[]
}

// kind → what it is + what it can back. Adding a provider is one entry here plus its
// client code and host seams.
export const PROVIDER_CATALOG: Record<string, ProviderCatalogEntry> = {
	google: {
		name: 'Google',
		authKind: 'oauth',
		caps: [
			{ capability: 'email', scope: GMAIL_SCOPE },
			{ capability: 'calendar', scope: CALENDAR_SCOPE }
		]
	},
	icloud: {
		name: 'iCloud',
		authKind: 'form',
		credentialsSchema: ICLOUD_SCHEMA,
		caps: [{ capability: 'calendar' }]
	},
	chatgpt: { name: 'ChatGPT', authKind: 'oauth', caps: [{ capability: 'ai' }] },
	spud: {
		name: 'Spud AI',
		authKind: 'form',
		builtin: true,
		credentialsSchema: { type: 'object', properties: {} },
		caps: [{ capability: 'ai' }]
	}
}

// The scope a capability needs for a given provider kind, if any (undefined = the
// capability is granted by the connection existing, or is not scope-gated).
export function scopeFor(kind: string, capability: CapabilityId): string | undefined {
	return PROVIDER_CATALOG[kind]?.caps.find((entry) => entry.capability === capability)?.scope
}

// Whether a connection is CAPABLE of a scope-gated capability: its kind declares the
// capability and the required scope has been granted. Note this is "capable", not "the
// active AI" — ai's single-active selection lives in active-ai.ts, so email/calendar are
// the meaningful callers.
export function backs(connection: Connection, capability: CapabilityId): boolean {
	const entry = PROVIDER_CATALOG[connection.kind]?.caps.find((e) => e.capability === capability)
	if (!entry) return false
	return entry.scope === undefined || (connection.scopes?.includes(entry.scope) ?? false)
}

// The capabilities a provider kind can back at all (for the connect UI / provider info).
export function capabilitiesOf(kind: string): CapabilityId[] {
	return (PROVIDER_CATALOG[kind]?.caps ?? []).map((entry) => entry.capability)
}
