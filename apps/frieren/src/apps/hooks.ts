import { useEffect, useMemo, useRef, useState } from 'react'
import {
	COMMUNITY_CATALOG_PATH,
	type CommunityCatalog,
	type CommunityCatalogApp,
	UPDATE_CHECK_INTERVAL_MS
} from '../../shared/appstore'
import { useOsClient, useOsDispatch, useOsRuntime } from '../os/hooks'
import {
	beginInstall,
	endInstall,
	getInstalling,
	type InstallingApp,
	subscribeInstalling
} from './installing'
import { installCommunityApp, installZipApp, uninstallLocalApp } from './manage'
import type { InstalledApp } from './types'

function pickZipFile(): Promise<File | null> {
	return new Promise((resolve) => {
		const input = document.createElement('input')
		input.type = 'file'
		input.accept = '.zip,application/zip'
		input.onchange = () => resolve(input.files?.[0] ?? null)
		input.click()
	})
}

// The installed-app catalog the OS client owns, mirrored into local state so it
// stays out of OS context (which holds only stable store/client objects).
export function useInstalledApps(): InstalledApp[] {
	const client = useOsClient()
	const [apps, setApps] = useState<InstalledApp[]>([])
	useEffect(() => client.subscribeApps(setApps), [client])
	return apps
}

// The apps currently downloading/installing in the background (launcher tiles).
export function useInstallingApps(): InstallingApp[] {
	const [apps, setApps] = useState<InstallingApp[]>(getInstalling)
	useEffect(() => subscribeInstalling(setApps), [])
	return apps
}

// The community catalog (`/store/catalog.json`). Fetched on mount and re-fetched
// on the same slow checkpoint as the update pass, so a long-lived tab's store
// listing (and its held-update rows) don't go stale against a newer release. An
// empty catalog (unpublished / not yet indexed) simply yields no candidates.
// Discovery only — installing still routes through the consent sheet.
export function useCommunityCatalog(): CommunityCatalogApp[] {
	const [apps, setApps] = useState<CommunityCatalogApp[]>([])
	useEffect(() => {
		let live = true
		const load = () => {
			fetch(COMMUNITY_CATALOG_PATH)
				.then((res) => (res.ok ? (res.json() as Promise<CommunityCatalog>) : null))
				.then((cat) => {
					if (live && cat) setApps(cat.apps)
				})
				.catch(() => {})
		}
		load()
		const timer = setInterval(load, UPDATE_CHECK_INTERVAL_MS)
		return () => {
			live = false
			clearInterval(timer)
		}
	}, [])
	return apps
}

export interface AppCommands {
	launchApp: (app: InstalledApp) => void
	installApp: () => Promise<void>
	installCommunity: (app: CommunityCatalogApp) => Promise<void>
	uninstallApp: (id: string) => Promise<void>
}

// App launch/install/uninstall are OS-level local-volume actions. Sync later
// replicates the files when a backend is connected.
export function useAppCommands(): AppCommands {
	const client = useOsClient()
	const dispatch = useOsDispatch()
	const { localKernel, volume } = useOsRuntime()
	const installingRef = useRef(false)

	return useMemo<AppCommands>(() => {
		const launchApp = (app: InstalledApp) => {
			dispatch({ type: 'app.open', appId: app.id, title: app.name })
		}

		const installApp = async () => {
			if (installingRef.current) return
			installingRef.current = true
			try {
				const zip = await pickZipFile()
				if (!zip) return
				await installZipApp(await localKernel(), new Uint8Array(await zip.arrayBuffer()))
				client.refresh()
			} catch (e) {
				alert(`Install failed: ${e instanceof Error ? e.message : String(e)}`)
			} finally {
				installingRef.current = false
			}
		}

		const uninstallApp = async (id: string) => {
			// Close any open window first. Otherwise the app drops from the catalog
			// while its frame is still mounted, the effect re-fires, and the GUI's
			// React root unmounts synchronously from inside the parent's commit —
			// corrupting the DOM (NotFoundError on removeChild). The close effect
			// also tears down the app-host stage and notifies the server.
			dispatch({ type: 'window.close', id })
			client.removeApp(id)
			try {
				await uninstallLocalApp(await localKernel(), id)
				client.refresh()
			} catch (e) {
				// The volume still has it — refresh restores the optimistic removal.
				client.refresh()
				alert(`Uninstall failed: ${e instanceof Error ? e.message : String(e)}`)
			}
		}

		// Install runs in the background: mark the intent (tile + fs marker), return so
		// the consent sheet closes and the desktop is usable, then download. The app
		// isn't launchable until its bundle swaps in and `refresh` lists it.
		const installCommunity = async (app: CommunityCatalogApp): Promise<void> => {
			const fs = await volume
			const iconUrl = app.icon
				? `https://cdn.jsdelivr.net/npm/${app.npm}@${app.version}/dist/${app.icon}`
				: undefined
			await beginInstall(fs, { id: app.id, name: app.name, iconUrl })
			void (async () => {
				try {
					await installCommunityApp(await localKernel(), app.id)
				} catch (e) {
					alert(`Install failed: ${e instanceof Error ? e.message : String(e)}`)
				} finally {
					await endInstall(fs, app.id)
					client.refresh()
				}
			})()
		}

		return { launchApp, installApp, installCommunity, uninstallApp }
	}, [client, dispatch, localKernel, volume])
}
