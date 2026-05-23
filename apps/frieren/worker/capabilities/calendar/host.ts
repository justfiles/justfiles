// Trusted host wiring for the Calendar capability. Providers (iCloud, Google,
// etc.) register against `calendarHost` and the broker enforces method-level
// scopes per call.

import { defineProviderBackedCapability } from '@justfiles/app/kernel/capabilities/broker'
import { calendar } from '@justfiles/app/kernel/capabilities/calendar'

export const calendarHost = defineProviderBackedCapability({
	capability: calendar,
	methodScopes: {
		listToday: 'read.today'
	}
})
