export interface InstalledApp {
	id: string
	name: string
	description: string
	iconUrl?: string
	// Version-stamped URL of the app's gui.js, e.g. /api/apps/foo/gui.js?v=1.2.0.
	// Absent for builtins and for apps without a version in their manifest.
	guiUrl?: string
}
