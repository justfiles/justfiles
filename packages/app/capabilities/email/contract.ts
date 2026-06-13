// App-facing Email capability contract. No Cloudflare imports, no provider
// clients. Host wiring (broker, Fastmail/Gmail adapters) lives in Frieren.

export interface EmailSummary {
	id: string
	from: string
	subject: string
	receivedAt: number
	unread: boolean
	// Stamped by the host when results are aggregated across accounts, so the app
	// can route a later `readDetail`/`markRead` back to the right account.
	accountId?: string
}

export interface EmailDetail extends EmailSummary {
	bodyText: string
}

export interface EmailCapability {
	listUnread(input: { since?: number; limit?: number; accountId?: string }): Promise<EmailSummary[]>
	readDetail(input: {
		id: string
		accountId?: string
		purpose: 'briefing-detail' | 'summarization'
	}): Promise<EmailDetail>
	markRead(input: { id: string; accountId?: string }): Promise<{ success: true }>
}
