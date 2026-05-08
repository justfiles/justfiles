// Trusted host wiring for the Calendar capability. Providers (iCloud, Google,
// etc.) register against `calendarHost` and the broker enforces method-level
// scopes per call.

import { defineProviderBackedCapability } from '../../../../../packages/app/capabilities/broker.ts'
import { calendar } from '../../../../../packages/app/capabilities/calendar/index.ts'

export const calendarHost = defineProviderBackedCapability({
	capability: calendar,
	methodScopes: {
		listToday: 'read.today'
	}
})
