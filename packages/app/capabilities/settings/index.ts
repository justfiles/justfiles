import { defineCapability } from '../core.ts'
import type { SettingsCapability } from './contract.ts'

export type {
	AccountInfo,
	AccountOrigin,
	AgentSoul,
	AvatarInfo,
	CapabilityId,
	CredentialField,
	CredentialsSchema,
	DockMaterial,
	GeneratedSoul,
	ProviderInfo,
	SettingsCapability,
	UsageResource,
	UsageSnapshot,
	UsageWindow,
	UserFacts,
	UserProfile
} from './contract.ts'
export { DOCK_MATERIAL_NAMES } from './contract.ts'

// The `settings` capability: the host admin surface, reachable only by the
// first-party Settings app. Declared with NO scopes — the gate is app identity,
// enforced host-side (see `SETTINGS_ALLOWLIST` in ./host.ts), so a scope would
// only be decoration. Read ./contract.ts before adding a method.
export const settings = defineCapability<'settings', SettingsCapability>('settings')
