import type { ComponentType } from 'react'
import type { InstalledApp } from '../chat/types'
import { SettingsApp } from './SettingsApp'
import settingsIconUrl from './settings-icon.svg'

export interface BuiltinApp {
	id: string
	name: string
	description: string
	iconUrl?: string
	component: ComponentType
}

export const BUILTIN_APPS: BuiltinApp[] = [
	{
		id: 'settings',
		name: 'Settings',
		description: 'Manage integrations',
		iconUrl: settingsIconUrl,
		component: SettingsApp
	}
]

export function findBuiltin(id: string): BuiltinApp | undefined {
	return BUILTIN_APPS.find((app) => app.id === id)
}

export function builtinLauncherEntries(): InstalledApp[] {
	return BUILTIN_APPS.map((app) => ({
		id: app.id,
		name: app.name,
		description: app.description,
		iconUrl: app.iconUrl,
		kind: 'builtin'
	}))
}
