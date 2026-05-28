import { useAuth } from '@clerk/clerk-react'
import { useEffect, useRef, useState } from 'react'
import { useOsClient, useOsDispatch } from '../os/hooks'
import type { InstalledApp, Launcher } from './types'

// TODO(slice 8): the installed-app catalog and launch/install/uninstall
// commands are OS-level concerns and move to the OS provider (useInstalledApps
// / useAppCommands). This hook is the transitional home until then.

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

export function useLauncher(): Launcher {
	const { getToken } = useAuth()
	const client = useOsClient()
	const dispatch = useOsDispatch()

	const [installedApps, setInstalledApps] = useState<InstalledApp[]>([])
	const getTokenRef = useRef(getToken)
	getTokenRef.current = getToken
	const installingAppRef = useRef(false)

	useEffect(() => client.subscribeApps(setInstalledApps), [client])

	const launchApp = (app: InstalledApp) => {
		dispatch({ type: 'app.open', appId: app.id, title: app.name })
	}

	// Reconnect re-runs the handshake so a fresh `ready` re-lists installed apps.
	const reconnect = () => client.connect()

	// Dev install: prompt the user for a zipped app bundle, upload it to
	// the install endpoint, then reconnect so the launcher re-lists apps.
	const installApp = async () => {
		if (installingAppRef.current) return
		installingAppRef.current = true
		try {
			await installAppOnce()
		} finally {
			installingAppRef.current = false
		}
	}

	const installAppOnce = async () => {
		const zip = await pickZipFile()
		if (!zip) return
		try {
			const form = new FormData()
			form.append('bundle', zip)
			const res = await fetch('/api/apps/install', {
				method: 'POST',
				headers: { authorization: `Bearer ${await getTokenRef.current()}` },
				body: form
			})
			if (!res.ok) throw new Error(await responseError(res))
			reconnect()
		} catch (e) {
			alert(`Install failed: ${e instanceof Error ? e.message : String(e)}`)
		}
	}

	// Delete an app bundle through the app lifecycle endpoint and drop it from
	// the launcher state optimistically. Mirror of `installApp`.
	const uninstallApp = async (id: string) => {
		const prev = installedApps
		// Close any open window for this app first. Otherwise the still-mounted
		// app frame sees its `guiUrl` go undefined when the launcher drops the
		// app, the effect re-fires, and the GUI's React root is unmounted
		// synchronously from inside the parent's commit — corrupting the DOM
		// (NotFoundError on removeChild) and leaving the desktop in a half-
		// broken state where the user sees "nothing happens". The close effect
		// also tears down the app-host stage and notifies the server.
		dispatch({ type: 'window.close', id })
		setInstalledApps((apps) => apps.filter((a) => a.id !== id))
		try {
			const res = await fetch(`/api/apps/${encodeURIComponent(id)}`, {
				method: 'DELETE',
				headers: { authorization: `Bearer ${await getTokenRef.current()}` }
			})
			if (!res.ok) throw new Error(await responseError(res))
		} catch (e) {
			setInstalledApps(prev)
			alert(`Uninstall failed: ${e instanceof Error ? e.message : String(e)}`)
		}
	}

	return {
		installedApps,
		launch: launchApp,
		installApp,
		uninstallApp
	}
}
