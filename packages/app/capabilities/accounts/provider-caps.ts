// The static "auth config" for capability backing — the analog of a Composio Auth
// Config or Arcade's per-tool scopes. It declares, in CODE (never per-user state),
// what each provider kind can back and the OAuth scope each capability needs.
//
// Capability availability is DERIVED from a connection's kind + granted scopes; there
// is no persisted capability→connection table. This mirrors how the field does it:
// Composio scopes a connection to a toolkit; Arcade derives availability from the
// token's granted scopes. The one thing that can't be derived — which connection is
// the single active AI — lives in `active-ai.ts`.

import type { Connection } from './connection.ts'
import type { CapabilityId } from './contract.ts'

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify'
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'

// kind → the capabilities it can back, and (for oauth kinds) the scope each needs. A
// capability with no `scope` is granted by the connection simply existing — form
// providers (iCloud), and ai (whose single-active selection lives in active-ai.ts).
const PROVIDER_CAPS: Record<string, { capability: CapabilityId; scope?: string }[]> = {
	google: [
		{ capability: 'email', scope: GMAIL_SCOPE },
		{ capability: 'calendar', scope: CALENDAR_SCOPE }
	],
	icloud: [{ capability: 'calendar' }],
	chatgpt: [{ capability: 'ai' }],
	spud: [{ capability: 'ai' }]
}

// The scope a capability needs for a given provider kind, if any (undefined = the
// capability is granted by the connection existing).
export function scopeFor(kind: string, capability: CapabilityId): string | undefined {
	return PROVIDER_CAPS[kind]?.find((entry) => entry.capability === capability)?.scope
}

// Whether a connection is CAPABLE of a capability: its kind declares the capability
// and (for scope-gated capabilities) the required scope has been granted. Note this
// is "capable", not "the active AI" — single-active ai selection lives in active-ai.ts.
export function backs(connection: Connection, capability: CapabilityId): boolean {
	const entry = PROVIDER_CAPS[connection.kind]?.find((e) => e.capability === capability)
	if (!entry) return false
	return entry.scope === undefined || (connection.scopes?.includes(entry.scope) ?? false)
}

// The capabilities a provider kind can back at all (for the connect UI / provider info).
export function capabilitiesOf(kind: string): CapabilityId[] {
	return (PROVIDER_CAPS[kind] ?? []).map((entry) => entry.capability)
}
