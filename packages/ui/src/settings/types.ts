export type Category = 'agent' | 'account' | 'accounts' | 'appearance' | 'system'
export function settingsCategory(value?: string): Category {
	return value === 'account' || value === 'accounts' || value === 'appearance' || value === 'system'
		? value
		: 'agent'
}

import type { AccountsAdmin } from '@justfiles/app/accounts'

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

export interface SettingsHost {
	listProviders: AccountsAdmin['listProviders']
	listAccounts: AccountsAdmin['listAccounts']
	connectAccount: AccountsAdmin['connect']
	beginAccountConnection: AccountsAdmin['beginConnect']
	completeAccountConnection: AccountsAdmin['completeConnect']
	readAccountConnection: AccountsAdmin['readConnect']
	cancelAccountConnection: AccountsAdmin['cancelConnect']
	openAccountConnection(input: Parameters<AccountsAdmin['readConnect']>[0]): Promise<void>
	setAccountEnabled: AccountsAdmin['setEnabled']
	disconnectAccount: AccountsAdmin['disconnect']
	readUsage(input: Record<string, never>): Promise<UsageSnapshot>
	readUser(input: Record<string, never>): Promise<UserProfile | null>
	readVersion(input: Record<string, never>): Promise<string>
	readSoul(input: Record<string, never>): Promise<AgentSoul>
	writeSoul(input: {
		name?: string
		gender?: 'female' | 'male'
		body?: string
		avatar?: string
	}): Promise<void>
	listAvatars(input: Record<string, never>): Promise<AvatarInfo[]>
	putAvatarFile(input: { avatar: string; name: string; bytes: Uint8Array | null }): Promise<void>
	readProfile(input: Record<string, never>): Promise<UserFacts>
	writeProfile(input: {
		name?: string
		birthDate?: string
		gender?: 'female' | 'male' | null
	}): Promise<void>
	generateSoul(input: {
		name: string
		gender: 'female' | 'male'
		archetype?: string
		user?: { birthDate?: string; gender?: 'female' | 'male' | null }
	}): Promise<GeneratedSoul>
	readWallpaper(input: Record<string, never>): Promise<Uint8Array | null>
	writeWallpaper(input: { bytes: Uint8Array | null }): Promise<void>
	readDockMaterial(input: Record<string, never>): Promise<DockMaterial | null>
	writeDockMaterial(input: { material: DockMaterial }): Promise<void>
}
