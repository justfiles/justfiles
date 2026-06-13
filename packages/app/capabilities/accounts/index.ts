import { defineCapability } from '../core.ts'
import type { AccountsAdminCapability } from './contract.ts'

export type {
	AccountInfo,
	AccountsAdminCapability,
	CapabilityId,
	CredentialField,
	CredentialsSchema,
	ProviderInfo
} from './contract.ts'

// The admin facet of the `accounts` capability. Apps declare it with the
// conventional `admin` scope, but the scope grants nothing on its own — the host
// gates it on first-party app identity (see `accountsAdminHost`), mirroring the
// volume capability's `system` allowlist. Only the Settings app binds it.
export const accountsAdmin = defineCapability<'accounts', AccountsAdminCapability>('accounts')
