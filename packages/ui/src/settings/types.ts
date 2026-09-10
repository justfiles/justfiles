export type Category = 'agent' | 'account' | 'accounts' | 'appearance' | 'system'
export function settingsCategory(value?: string): Category {
	return value === 'account' || value === 'accounts' || value === 'appearance' || value === 'system'
		? value
		: 'agent'
}

export type {
	AccountInfo,
	AccountOrigin,
	AccountsAdmin,
	CapabilityId,
	ConnectRef,
	ConnectState,
	CredentialField,
	CredentialsSchema,
	ProviderInfo
} from '@justfiles/app/accounts'
export interface UsageResource {
	used: number
	limit: number | null
	remaining: number | null
	exceeded: boolean
	fraction: number
}
export interface UsageWindow extends UsageResource {
	resetsAt: number | null
}
export interface UsageSnapshot {
	tier: string
	aiBurst: UsageWindow
	aiWeekly: UsageWindow
	storage: UsageResource
	aiTokens: number
	aiRequests: number
}
export interface UserProfile {
	id: string
	name?: string
	avatarUrl?: string
}
export interface AgentSoul {
	name: string
	gender: 'female' | 'male' | null
	avatar: string | null
	body: string
	seeded: boolean
}
export interface AvatarInfo {
	ref: string
	label: string
	builtin: boolean
	preview: string
	files: string[]
}
export interface UserFacts {
	name: string
	birthDate: string
	gender: 'female' | 'male' | null
}
export interface GeneratedSoul {
	body: string
	firstWords?: string
}

export const DOCK_MATERIAL_NAMES = ['clear', 'frosted', 'smoked', 'solid'] as const
export type DockMaterial = (typeof DOCK_MATERIAL_NAMES)[number]

export const WALLPAPER_PATH = '/system/wallpaper'
export const DOCK_MATERIAL_PATH = '/system/dock-material'
