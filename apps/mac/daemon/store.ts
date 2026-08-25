import { installApp } from '@justfiles/app/appstore'
import type { CapabilityDecl, Kernel } from '@justfiles/app/runtime'
import { type RunnerCatalogApp, runnerAppStore } from '../../shared/justapps'

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

// What the last listing resolved, by id. An install replays one of these entries rather than
// re-resolving the registry: the pointer can move between the consent sheet rendering and the
// user confirming it, and a fresh resolve would land capabilities nobody reviewed. Nothing here
// is trusted from the caller — not even a fingerprint, which the publisher would author too.
//
// One cache for the whole daemon, replaced per listing — so a SECOND listing (another launcher,
// or this one reopened) between a sheet rendering and its confirm can still swap a same-version
// release under it. Binding each sheet to its own retained offer is the fix, and it needs a
// handle in the route: tasks/mac-store-consent-binding.md.
let offered = new Map<string, RunnerCatalogApp>()

// Every app JustApps publishes. Installed-or-not is the launcher's call: it already holds the
// catalog the daemon pushes, so this stays a plain listing.
export async function storeCatalog(): Promise<StoreApp[]> {
	const store = await runnerAppStore()
	if (!store) throw new Error('app store unavailable')
	const apps = await store.catalog()
	offered = new Map(apps.map((app) => [app.id, app]))
	return apps.map(({ id, name, version, description, iconUrl, repository, capabilities }) => ({
		id,
		name,
		version,
		description,
		iconUrl,
		repository,
		capabilities
	}))
}

// Install (or re-install, for a held capability-escalating update) one listed app — `version`
// being the release the consent sheet showed, so a page holding an older listing than the
// daemon's is refused rather than installed.
export async function installStoreApp(kernel: Kernel, id: string, version: string): Promise<void> {
	const app = offered.get(id)
	if (!app || app.version !== version)
		throw new Error(`${id} ${version} is not what the App Store lists — reopen it and try again`)
	const store = await runnerAppStore()
	if (!store) throw new Error('app store unavailable')
	await installApp(kernel, store, app)
}
