import { installApp } from '@justfiles/app/appstore'
import type { CapabilityDecl } from '@justfiles/app/runtime'
import { runnerAppStore } from '../../shared/justapps'
import { getKernel } from './kernel'

// The App Store seam for the launcher. The daemon browses and installs — not the
// webview — because the kernel and the Volume live here; the tile only renders what
// this returns and asks for an id back.

// One catalog row. Deliberately NOT the whole `RunnerCatalogApp`: its `files` list runs
// to hundreds of entries per app (Code ships a sysroot), and the tile shows none of it.
export interface StoreApp {
	id: string
	name: string
	version: string
	description?: string
	iconUrl?: string
	repository?: string
	// What the consent sheet gates on, straight from the published manifest — so
	// nothing runs to show it.
	capabilities?: CapabilityDecl
}

// Every app JustApps publishes. Installed-or-not is the launcher's call: it already
// holds the catalog the daemon pushes, so this stays a plain listing.
export async function storeCatalog(): Promise<StoreApp[]> {
	const store = await runnerAppStore()
	if (!store) throw new Error('app store unavailable')
	return (await store.catalog()).map(
		({ id, name, version, description, iconUrl, repository, capabilities }) => ({
			id,
			name,
			version,
			description,
			iconUrl,
			repository,
			capabilities
		})
	)
}

// Install (or re-install, for a held capability-escalating update) one published app.
// Resolves the store's current pointer rather than trusting the version the tile saw.
export async function installStoreApp(id: string): Promise<void> {
	const store = await runnerAppStore()
	if (!store) throw new Error('app store unavailable')
	const app = await store.latest(id)
	if (!app) throw new Error(`not in the app store: ${id}`)
	await installApp(await getKernel(), store, app)
}
