import { installApp } from '@justfiles/app/appstore'
import type { CapabilityDecl, Kernel } from '@justfiles/app/runtime'
import { runnerAppStore } from '../../shared/justapps'
import { PACKAGED_IDS } from './builtins'

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

// Every app JustApps publishes, minus the ones this Mac packages itself — a packaged app is
// authoritative, so a published entry under its id is not ours to offer. Installed-or-not is
// the launcher's call: it already holds the catalog the daemon pushes, so this stays a plain
// listing.
export async function storeCatalog(): Promise<StoreApp[]> {
	const store = await runnerAppStore()
	if (!store) throw new Error('app store unavailable')
	return (await store.catalog())
		.filter((app) => !PACKAGED_IDS.includes(app.id))
		.map(({ id, name, version, description, iconUrl, repository, capabilities }) => ({
			id,
			name,
			version,
			description,
			iconUrl,
			repository,
			capabilities
		}))
}

// Install (or re-install, for a held capability-escalating update) one published app —
// `version` being the exact release the consent sheet showed. The registry pointer can move
// between rendering that sheet and confirming it, and installing what the user did not review
// would grant capabilities nobody consented to, so a moved pointer fails the install.
export async function installStoreApp(kernel: Kernel, id: string, version: string): Promise<void> {
	if (PACKAGED_IDS.includes(id)) throw new Error(`packaged with this Mac: ${id}`)
	const store = await runnerAppStore()
	if (!store) throw new Error('app store unavailable')
	const app = await store.latest(id)
	if (!app) throw new Error(`not in the app store: ${id}`)
	if (app.version !== version)
		throw new Error(`the App Store moved on: ${id} is now ${app.version} — reopen it and try again`)
	await installApp(kernel, store, app)
}
