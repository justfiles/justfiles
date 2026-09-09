import type {
	AccountInfo,
	AgentSoul,
	Category,
	DockMaterial,
	ProviderInfo,
	UsageSnapshot,
	UserFacts,
	UserProfile
} from './types.ts'

export type { Category } from './types.ts'
export const WALLPAPER_COLORS: { name: string; hex: string }[] = [
	{ name: 'Ink', hex: '#23262a' },
	{ name: 'Graphite', hex: '#33383d' },
	{ name: 'Slate', hex: '#3b4650' },
	{ name: 'Moss', hex: '#46534a' },
	{ name: 'Clay', hex: '#4e453f' },
	{ name: 'Plum', hex: '#413a47' },
	{ name: 'Fog', hex: '#a8aeb0' },
	{ name: 'Paper', hex: '#e7e2d9' }
]

export const DOCK_MATERIALS: readonly {
	name: DockMaterial
	label: string
	caption: string
}[] = [
	{
		name: 'clear',
		label: 'Clear',
		caption: 'The wallpaper keeps its shapes. Least forgiving of a busy one.'
	},
	{
		name: 'frosted',
		label: 'Frosted',
		caption: 'Milky and soft. Colour survives, detail does not.'
	},
	{
		name: 'smoked',
		label: 'Smoked',
		caption: 'Darkened glass. The most contrast for labels — the default.'
	},
	{
		name: 'solid',
		label: 'Solid',
		caption: 'No transparency at all. Also what your system’s reduced-transparency setting forces.'
	}
]
const HEX = /^#[0-9a-f]{6}$/

export function normalizeHex(value: string): string | null {
	const hex = value.trim().toLowerCase()
	return HEX.test(hex) ? hex : null
}
export function colorWallpaper(hex: string): Uint8Array {
	const color = normalizeHex(hex)
	if (!color) throw new Error(`not a #rrggbb colour: ${hex}`)
	return new TextEncoder().encode(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 10"><rect width="16" height="10" fill="${color}"/></svg>`
	)
}
export function wallpaperColor(bytes: Uint8Array): string | null {
	if (bytes.length > 512) return null
	const text = new TextDecoder().decode(bytes)
	const match = /^<svg [^>]*><rect [^>]*fill="(#[0-9a-f]{6})"\/><\/svg>$/.exec(text.trim())
	return match?.[1] ?? null
}
export function originKind(account: AccountInfo): 'cloud' | 'device' {
	return account.origin?.kind ?? 'cloud'
}
export function hasBothOrigins(accounts: AccountInfo[]): boolean {
	const kinds = new Set(accounts.map(originKind))
	return kinds.has('cloud') && kinds.has('device')
}
export function isBound(soul: AgentSoul | null): boolean {
	return soul !== null && !soul.seeded
}
export function nameInSoul(soul: AgentSoul | null): string | null {
	const match = /^You are (\p{Lu}[^,.;:!?\n—–(]{0,60})/u.exec(soul?.body.trim() ?? '')
	return match?.[1]?.trim() || null
}

export type SettingsState = {
	category: Category
	user: UserProfile | null
	providers: ProviderInfo[]
	accounts: AccountInfo[]
	usage: UsageSnapshot | null
	usageAvailable: boolean
	usageError: string | null
	soul: AgentSoul | null
	facts: UserFacts | null
	loading: boolean
	error: string | null
}

export const initialState: SettingsState = {
	category: 'agent',
	user: null,
	providers: [],
	accounts: [],
	usage: null,
	usageAvailable: true,
	usageError: null,
	soul: null,
	facts: null,
	loading: true,
	error: null
}

export type { SettingsActions } from './useSettings.ts'
