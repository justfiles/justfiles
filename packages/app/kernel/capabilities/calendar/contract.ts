// App-facing Calendar capability contract.

export interface CalendarEvent {
	id: string
	title: string
	startsAt: number
	endsAt: number
	location?: string
	accountId?: string
}

export interface CalendarCapability {
	listToday(input: { timezone: string; accountId?: string; now?: number }): Promise<CalendarEvent[]>
}
