export interface InstalledApp {
	id: string
	name: string
	description: string
	version?: string
	iconUrl?: string
	capabilities?: Record<string, { id: string; scopes: string[] }>
}
