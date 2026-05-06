// Platform-agnostic capability contracts for sandboxed apps.
//
// No Cloudflare imports here. These types must compile and run in any
// sandbox/runtime. Provider clients, host bindings, and serialization adapters
// live in sibling modules.

export type CapabilityName =
	| 'email.read.unread'
	| 'email.read.detail'
	| 'email.markRead'
	| 'calendar.read.today'
	| 'volume.read'
	| 'volume.write'

export interface CapabilityGrant {
	name: CapabilityName
	accountId?: string
	scope?: Record<string, unknown>
}

export interface SandboxContext {
	userId: string
	appId: string
	appVersion: string
	grants: ReadonlyArray<CapabilityGrant>
}

export interface CapabilityError {
	code: 'CAPABILITY_DENIED' | 'ACCOUNT_NOT_CONFIGURED' | 'PROVIDER_ERROR' | 'INVALID_INPUT'
	message: string
}

export type CapabilityResult<T> = { ok: true; value: T } | { ok: false; error: CapabilityError }

export interface EmailAddressDTO {
	name?: string
	email: string
}

export interface EmailDTO {
	id: string
	accountId: string
	source: 'fastmail'
	from: EmailAddressDTO
	subject: string
	receivedAt: number
	preview: string
}

export interface EmailDetailDTO extends EmailDTO {
	to: ReadonlyArray<EmailAddressDTO>
	text: string
}

export interface CalendarEventDTO {
	id: string
	accountId: string
	source: 'icloud-calendar'
	title: string
	startAt: number
	endAt: number
	location?: string
	notes?: string
}

export interface ListUnreadInput {
	since?: number
	limit?: number
	accountId?: string
}

export interface ReadDetailInput {
	id: string
	accountId?: string
	purpose: 'briefing-detail' | 'summarization'
}

export interface MarkReadInput {
	id: string
	accountId?: string
}

export interface ListTodayInput {
	timezone: string
	accountId?: string
	now?: number
}

export interface ReadFileInput {
	path: string
}

export interface WriteFileInput {
	path: string
	data: Uint8Array
}

export interface EmailCapability {
	listUnread(input: ListUnreadInput): Promise<CapabilityResult<EmailDTO[]>>
	readDetail(input: ReadDetailInput): Promise<CapabilityResult<EmailDetailDTO>>
	markRead(input: MarkReadInput): Promise<CapabilityResult<{ success: true }>>
}

export interface CalendarCapability {
	listToday(input: ListTodayInput): Promise<CapabilityResult<CalendarEventDTO[]>>
}

export interface VolumeCapability {
	readFile(input: ReadFileInput): Promise<CapabilityResult<{ data: Uint8Array }>>
	writeFile(input: WriteFileInput): Promise<CapabilityResult<{ success: true }>>
}

export interface Capabilities {
	email: EmailCapability
	calendar: CalendarCapability
	volume: VolumeCapability
}

// Provider adapters are the deterministic backends behind capabilities. Each
// adapter is scoped to one account; the broker selects by accountId.

export interface EmailProviderAdapter {
	listUnread(input: { since?: number; limit?: number }): Promise<EmailDTO[]>
	readDetail(input: { id: string }): Promise<EmailDetailDTO>
	markRead(input: { id: string }): Promise<void>
}

export interface CalendarProviderAdapter {
	listToday(input: { timezone: string; now?: number }): Promise<CalendarEventDTO[]>
}

export interface VolumeProviderAdapter {
	readFile(input: { path: string }): Promise<Uint8Array>
	writeFile(input: { path: string; data: Uint8Array }): Promise<void>
}

export interface ProviderAdapters {
	email?: ReadonlyMap<string, EmailProviderAdapter>
	calendar?: ReadonlyMap<string, CalendarProviderAdapter>
	volume?: VolumeProviderAdapter
}

export interface AuditEvent {
	ts: number
	userId: string
	appId: string
	capability: CapabilityName
	accountId?: string
	ok: boolean
	errorCode?: CapabilityError['code']
}

export interface BrokerHooks {
	audit?(event: AuditEvent): Promise<void> | void
	now?(): number
}
