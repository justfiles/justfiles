import { useEffect, useMemo, useRef, useState } from 'react'
import {
	type RunnerCatalogApp,
	runnerAppStore,
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
export function useRunnerCatalog(enabled: boolean): RunnerCatalogApp[] {
	const [apps, setApps] = useState<RunnerCatalogApp[]>([])
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
				.catch(() => {})
		}
		load()
		const timer = setInterval(load, UPDATE_CHECK_INTERVAL_MS)
		return () => {
			live = false
			clearInterval(timer)
		}
	}, [enabled])
	return apps
}

// The first-party Settings app, which the shell opens by id: it is the only place the
// agent can be personalized now (the `settings` capability's `agent.*` methods), and two
// shell affordances point at it — the desktop menu and the omnibar's whisper.
const SETTINGS_APP = { id: 'app.justfiles.frieren.settings', name: 'Settings' }

export interface AppCommands {
	launchApp: (app: InstalledApp) => void
	/**
	 * Open Settings ON a pane. Defaults to the Agent pane — most callers are a
	 * personalize affordance; the desktop's "Change Wallpaper…" asks for 'appearance'.
	 */
	openSettings: (category?: 'agent' | 'appearance') => void
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
		const installRunner = async (app: RunnerCatalogApp): Promise<void> => {
			const fs = await volume
			await beginInstall(fs, { id: app.id, name: app.name, iconUrl: app.iconUrl })
			void (async () => {
				try {
					await installRunnerApp(await localKernel(), app.id)
				} catch (e) {
					alert(`Install failed: ${e instanceof Error ? e.message : String(e)}`)
				} finally {
					await endInstall(fs, app.id)
					client.refresh()
				}
			})()
		}

		const openSettings = (category: 'agent' | 'appearance' = 'agent') => {
			dispatch({ type: 'app.open', appId: SETTINGS_APP.id, title: SETTINGS_APP.name })
			// Selecting the pane is PART of opening it: the category persists, so someone who
			// last looked at Accounts would otherwise land back there from a button that said
			// "Personalize". The kernel is the same one the window subscribes to, so this
			// arrives whether Settings is booting, already open, or not running at all.
			void localKernel()
				.then((kernel) =>
					kernel.dispatch(SETTINGS_APP.id, {
						type: 'selectCategory',
						params: { category }
					})
				)
				.catch((error: unknown) => console.error('[settings] open on', category, 'failed:', error))
		}

		return { launchApp, openSettings, installApp, installRunner, uninstallApp }
	}, [client, dispatch, localKernel, volume])
}
