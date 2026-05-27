import type { ComponentType } from 'react'
import type { InstalledApp } from '../chat/types'
import { MessagesApp } from './MessagesApp'
import messagesIconUrl from './messages-icon.svg'

export interface BuiltinApp {
	id: string
	name: string
	description: string
	iconUrl?: string
	component: ComponentType
}

export const BUILTIN_APPS: BuiltinApp[] = [
	{
		id: 'messages',
		name: 'Messages',
		description: 'Chat with the agent',
		iconUrl: messagesIconUrl,
		component: MessagesApp
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
