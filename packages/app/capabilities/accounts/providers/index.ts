// Barrel for the shared provider host-seam types. The provider CLIENT factories
// (Gmail, Google Calendar, iCloud CalDAV) are imported directly by the capability
// hosts (see host.ts); the native hosts (spud-mac daemon, frieren Worker) only need
// the seam types to wire their platform-specific `AccountsDeps`.

export type { GoogleClient, GoogleCreds, OAuthSignIn } from './google.ts'
