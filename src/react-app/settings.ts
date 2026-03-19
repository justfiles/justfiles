export type Destination = {
	id: string
	name: string
	pathTemplate: string
}

export type Settings = {
	destinations: Destination[]
	lastUsedDestinationId: string | null
	theme: string
}

export const DEFAULT_DESTINATIONS: Destination[] = [
	{ id: 'default-inbox', name: 'Inbox', pathTemplate: 'inbox/{timestamp}' },
]

export const DEFAULT_SETTINGS: Settings = {
	destinations: DEFAULT_DESTINATIONS,
	lastUsedDestinationId: 'default-inbox',
	theme: 'light',
}

export const DAISYUI_THEMES = [
	'light', 'dark', 'cupcake', 'bumblebee', 'emerald', 'corporate',
	'synthwave', 'retro', 'cyberpunk', 'valentine', 'halloween', 'garden',
	'forest', 'aqua', 'lofi', 'pastel', 'fantasy', 'wireframe', 'black',
	'luxury', 'dracula', 'cmyk', 'autumn', 'business', 'acid', 'lemonade',
	'night', 'coffee', 'winter', 'dim', 'nord', 'sunset',
] as const

function lsSettingsKey(userId: string) {
	return `ghostore:${userId}:settings`
}

export function loadSettings(userId: string): Settings {
	try {
		const raw = localStorage.getItem(lsSettingsKey(userId))
		if (!raw) return { destinations: [...DEFAULT_DESTINATIONS], lastUsedDestinationId: DEFAULT_SETTINGS.lastUsedDestinationId, theme: DEFAULT_SETTINGS.theme }
		const parsed = JSON.parse(raw) as Partial<Settings>
		return {
			destinations: parsed.destinations?.length ? parsed.destinations : [...DEFAULT_DESTINATIONS],
			lastUsedDestinationId: parsed.lastUsedDestinationId ?? DEFAULT_SETTINGS.lastUsedDestinationId,
			theme: parsed.theme ?? DEFAULT_SETTINGS.theme,
		}
	} catch {
		return { destinations: [...DEFAULT_DESTINATIONS], lastUsedDestinationId: DEFAULT_SETTINGS.lastUsedDestinationId, theme: DEFAULT_SETTINGS.theme }
	}
}

export function saveSettings(patch: Partial<Settings>, userId: string): void {
	const current = loadSettings(userId)
	localStorage.setItem(lsSettingsKey(userId), JSON.stringify({ ...current, ...patch }))
}

export function getActiveDestination(settings: Settings): Destination {
	const found = settings.destinations.find((d) => d.id === settings.lastUsedDestinationId)
	return found ?? settings.destinations[0] ?? DEFAULT_DESTINATIONS[0]
}

export function genId(): string {
	return Math.random().toString(36).slice(2, 10)
}

export type TemplateToken = {
	token: string
	label: string
	description: string
	example: () => string
}

export const TEMPLATE_TOKENS: TemplateToken[] = [
	{
		token: '{timestamp}',
		label: 'timestamp',
		description: 'Unix timestamp in seconds',
		example: () => String(Math.floor(Date.now() / 1000)),
	},
	{
		token: '{datetime}',
		label: 'datetime',
		description: 'Date and time (YYYY-MM-DDTHH-MM-SS)',
		example: () => new Date().toISOString().slice(0, 19).replace(/:/g, '-'),
	},
	{
		token: '{date}',
		label: 'date',
		description: 'Current date (YYYY-MM-DD)',
		example: () => new Date().toISOString().slice(0, 10),
	},
	{
		token: '{year}',
		label: 'year',
		description: 'Four-digit year',
		example: () => String(new Date().getFullYear()),
	},
	{
		token: '{month}',
		label: 'month',
		description: 'Month, zero-padded (01–12)',
		example: () => String(new Date().getMonth() + 1).padStart(2, '0'),
	},
	{
		token: '{day}',
		label: 'day',
		description: 'Day of month, zero-padded (01–31)',
		example: () => String(new Date().getDate()).padStart(2, '0'),
	},
]

export function expandTemplate(template: string, at: Date = new Date()): string {
	return template
		.replace(/{timestamp}/g, String(Math.floor(at.getTime() / 1000)))
		.replace(/{datetime}/g, at.toISOString().slice(0, 19).replace(/:/g, '-'))
		.replace(/{date}/g, at.toISOString().slice(0, 10))
		.replace(/{year}/g, String(at.getFullYear()))
		.replace(/{month}/g, String(at.getMonth() + 1).padStart(2, '0'))
		.replace(/{day}/g, String(at.getDate()).padStart(2, '0'))
}
