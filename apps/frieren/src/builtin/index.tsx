import type { ComponentType } from 'react'
import type { InstalledApp } from '../chat/types'
import { SettingsApp } from './SettingsApp'

export interface BuiltinApp {
	id: string
	name: string
	description: string
	component: ComponentType
}

export const BUILTIN_APPS: BuiltinApp[] = [
	{
		id: 'settings',
		name: 'Settings',
		description: 'Manage integrations',
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
		kind: 'builtin'
	}))
}
