import { useAuth } from '@clerk/clerk-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useOsClient, useOsDispatch } from '../os/hooks'
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

async function responseError(res: Response): Promise<string> {
	try {
		const body = (await res.json()) as { error?: unknown }
		if (typeof body.error === 'string') return body.error
	} catch {}
	return `${res.status} ${res.statusText}`
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

// App launch/install/uninstall are OS-level actions. Install/uninstall hit the
// dev-only host HTTP endpoints; catalog re-listing goes through the client so
// the raw websocket never leaks to the UI.
export function useAppCommands(): AppCommands {
	const { getToken } = useAuth()
	const client = useOsClient()
	const dispatch = useOsDispatch()
	const getTokenRef = useRef(getToken)
	getTokenRef.current = getToken
	const installingRef = useRef(false)

	return useMemo<AppCommands>(() => {
		const launchApp = (app: InstalledApp) => {
			dispatch({ type: 'app.open', appId: app.id, title: app.name })
		}

		// Prompt for a zipped app bundle, upload it, then refresh so a fresh
		// `ready` re-lists the catalog.
		const installApp = async () => {
			if (installingRef.current) return
			installingRef.current = true
			try {
				const zip = await pickZipFile()
				if (!zip) return
				const form = new FormData()
				form.append('bundle', zip)
				const res = await fetch('/api/apps/install', {
					method: 'POST',
					headers: { authorization: `Bearer ${await getTokenRef.current()}` },
					body: form
				})
				if (!res.ok) throw new Error(await responseError(res))
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
				const res = await fetch(`/api/apps/${encodeURIComponent(id)}`, {
					method: 'DELETE',
					headers: { authorization: `Bearer ${await getTokenRef.current()}` }
				})
				if (!res.ok) throw new Error(await responseError(res))
			} catch (e) {
				// The server still has it — refresh restores the optimistic removal.
				client.refresh()
				alert(`Uninstall failed: ${e instanceof Error ? e.message : String(e)}`)
			}
		}

		return { launchApp, installApp, uninstallApp }
	}, [client, dispatch])
}
