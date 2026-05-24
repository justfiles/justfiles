import type { ComponentType } from 'react'
import type { InstalledApp } from '../chat/types'
import { FinderApp } from './FinderApp'
import finderIconUrl from './finder-icon.svg'
import { MessagesApp } from './MessagesApp'
import messagesIconUrl from './messages-icon.svg'
import { PaintApp } from './paint/PaintApp'
import paintIconUrl from './paint-icon.svg'
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
		id: 'finder',
		name: 'Finder',
		description: 'Browse and preview files',
		iconUrl: finderIconUrl,
		component: FinderApp
	},
	{
		id: 'messages',
		name: 'Messages',
		description: 'Chat with the agent',
		iconUrl: messagesIconUrl,
		component: MessagesApp
	},
	{
		id: 'paint',
		name: 'Paint',
		description: 'Pixel drawing',
		iconUrl: paintIconUrl,
		component: PaintApp
	},
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
