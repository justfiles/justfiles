import type { Category } from '@justfiles/ui/settings/types'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
	type RunnerCatalogApp,
	runnerAppStore,
	UPDATE_CHECK_INTERVAL_MS
} from '../../../shared/justapps'
import { useOsClient, useOsDispatch, useOsRuntime } from '../os/hooks'
import { systemDialog } from './dialogs'
import {
	beginInstall,
	endInstall,
	getInstalling,
	type InstallingApp,
	subscribeInstalling
} from './installing'
import { installRunnerApp, installZipApp, uninstallLocalApp } from './manage'
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

// Runner's store index, hydrated with each app's canonical manifest only while the
// user is searching or browsing the store. Reconciliation checks installed ids
// separately, so an idle desktop never fans out across the whole public catalog.
export function useRunnerCatalog(enabled: boolean): {
	apps: RunnerCatalogApp[]
	loading: boolean
} {
	const [apps, setApps] = useState<RunnerCatalogApp[] | null>(null)
	useEffect(() => {
		if (!enabled) return
		let live = true
		const load = () => {
			runnerAppStore()
				.then(async (store) => {
					if (store) return store.catalog()
					return []
				})
				.then((catalog) => {
					if (live) setApps(catalog)
				})
				.catch(() => {
					if (live) setApps([])
				})
		}
		load()
		const timer = setInterval(load, UPDATE_CHECK_INTERVAL_MS)
		return () => {
			live = false
			clearInterval(timer)
		}
	}, [enabled])
	return { apps: apps ?? [], loading: enabled && apps === null }
}

export interface AppCommands {
	launchApp: (app: InstalledApp) => void
	/**
	 * Open Settings ON a pane. Defaults to the Agent pane — most callers are a
	 * personalize affordance; the desktop's "Change Wallpaper…" asks for 'appearance'.
	 */
	openSettings: (category?: Category) => void
	installApp: () => Promise<void>
	installRunner: (app: RunnerCatalogApp) => Promise<void>
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
				void systemDialog
					.alert({
						title: 'Install failed',
						body: e instanceof Error ? e.message : String(e)
					})
					.catch(() => {})
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
				void systemDialog
					.alert({
						title: 'Uninstall failed',
						body: e instanceof Error ? e.message : String(e)
					})
					.catch(() => {})
			}
		}

		// Install runs in the background: mark the intent (tile + fs marker), return so
		// the consent sheet closes and the desktop is usable, then download. The app
		// isn't launchable until its bundle swaps in and `refresh` lists it.
		const installRunner = async (app: RunnerCatalogApp): Promise<void> => {
			const fs = await volume
			await beginInstall(fs, { id: app.id, name: app.name, iconUrl: app.iconUrl })
			void (async () => {
				try {
					await installRunnerApp(await localKernel(), app.id)
				} catch (e) {
					void systemDialog
						.alert({
							title: 'Install failed',
							body: e instanceof Error ? e.message : String(e)
						})
						.catch(() => {})
				} finally {
					await endInstall(fs, app.id)
					client.refresh()
				}
			})()
		}

		const openSettings = (category: Category = 'agent') =>
			dispatch({ type: 'settings.open', category })

		return { launchApp, openSettings, installApp, installRunner, uninstallApp }
	}, [client, dispatch, localKernel, volume])
}
