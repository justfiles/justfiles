// Barrel for the provider registry: the shared provider constructors (each takes
// only what differs per platform) and the registry types hosts implement against.

export type {
	AcquiredAccount,
	AiModel,
	Auth,
	AuthFlow,
	Binding,
	BoundAccount,
	CredentialAccess,
	Provider
} from '../provider.ts'
export {
	CALENDAR_SCOPE,
	GMAIL_SCOPE,
	type GoogleClient,
	type GoogleCreds,
	googleProvider
} from './google.ts'
export { icloudProvider } from './icloud.ts'
export { platformProvider } from './platform.ts'
