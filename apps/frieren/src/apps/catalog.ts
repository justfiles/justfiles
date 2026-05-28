import type { InstalledApp } from './types'

// Window titles derive from live catalog metadata. The persisted title is only
// a boot-time fallback for windows restored before the catalog arrives; the
// appId is the last resort so a window never renders blank.
export function resolveAppTitle(
	apps: InstalledApp[],
	appId: string,
	fallbackTitle?: string
): string {
	return apps.find((app) => app.id === appId)?.name ?? fallbackTitle ?? appId
}
