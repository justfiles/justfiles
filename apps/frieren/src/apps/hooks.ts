import { useEffect, useMemo, useRef, useState } from 'react'
import { useOsClient, useOsDispatch, useOsRuntime } from '../os/hooks'
import { installZipApp, uninstallLocalApp } from './manage'
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

export interface AppCommands {
	launchApp: (app: InstalledApp) => void
	installApp: () => Promise<void>
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
				await installZipApp(
					await localKernel(),
					await volume,
					new Uint8Array(await zip.arrayBuffer())
				)
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
				await uninstallLocalApp(await localKernel(), await volume, id)
				client.refresh()
			} catch (e) {
				// The volume still has it — refresh restores the optimistic removal.
				client.refresh()
				alert(`Uninstall failed: ${e instanceof Error ? e.message : String(e)}`)
			}
		}

		return { launchApp, installApp, uninstallApp }
	}, [client, dispatch, localKernel, volume])
}
