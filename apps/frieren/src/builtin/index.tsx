import type { ComponentType } from 'react'
import type { InstalledApp } from '../chat/types'

export interface BuiltinApp {
	id: string
	name: string
	description: string
	iconUrl?: string
	component: ComponentType
}

// Messages used to live here. It's now OS chrome (see chat/MessagesPanel)
// invoked from the menubar, not the launcher. Paint/Finder/Settings are
// kernel apps. This list is empty in the new architecture; Part 9 deletes
// the file along with BuiltinHost.tsx.
export const BUILTIN_APPS: BuiltinApp[] = []

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
