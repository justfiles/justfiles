// The Google provider — the Slice-3 payoff in one object. ONE oauth account backs
// BOTH `email` and `calendar`: the thing the old per-capability broker registry
// couldn't express, here just two keys on `mint`. Per-capability `scopes` drive
// incremental consent — connect grabs identity, enabling email widens to Gmail,
// enabling calendar widens again — all in the accounts host, no code here.

import type { Provider } from '@justfiles/app/capabilities/accounts/host'
import { createGoogleCalendar } from './calendar.ts'
import { createGmailEmail } from './gmail.ts'
import { authedFetch, type GoogleCreds, googleSignIn } from './oauth.ts'

export const GOOGLE_PROVIDER_ID = 'google'

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify'
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'

export const googleProvider: Provider = {
	id: GOOGLE_PROVIDER_ID,
	name: 'Google',
	auth: {
		kind: 'oauth',
		scopes: { email: [GMAIL_SCOPE], calendar: [CALENDAR_SCOPE] },
		signIn: googleSignIn
	},
	mint: {
		email: (creds) => createGmailEmail(authedFetch(creds as GoogleCreds)),
		calendar: (creds) => createGoogleCalendar(authedFetch(creds as GoogleCreds))
	}
}
