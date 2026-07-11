import { useAuth } from '@clerk/clerk-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { appFileUrl } from '../../shared/appstore'
import { resetCapabilitySocket } from '../apps/capabilities.client'
import * as appHost from '../apps/host'
import { createClientKernel } from '../apps/kernel.client'
import type { InstalledApp } from '../apps/types'
import { openProfile } from '../fs'
import { createFrierenClient } from './client'
import { OsContext } from './hooks'
import { startOsRuntime } from './runtime'
import { createOsStore } from './store'

export function OSProvider({ children }: { children: ReactNode }) {
	const { getToken, isLoaded, isSignedIn, userId } = useAuth()
	const getTokenRef = useRef(getToken)
	getTokenRef.current = getToken

	// The current profile volume is opened at boot (App); the singleton hands back
	// the same replica. getToken is only needed by network capabilities.
	const [volumePromise] = useState(() => openProfile())
	const [localKernel] = useState(() => {
		let kernelPromise: Promise<ReturnType<typeof createClientKernel>> | undefined
		return () =>
			(kernelPromise ??= volumePromise.then((fs) =>
				createClientKernel({ fs, getToken: () => getTokenRef.current() })
			))
	})
	const [client] = useState(() =>
		createFrierenClient({
			getToken: () => getTokenRef.current(),
			listLocalApps: async (): Promise<InstalledApp[]> => {
				const kernel = await localKernel()
				return Promise.all(
					(await kernel.list()).map(async (m) => {
						let iconUrl: string | undefined
						if (m.icon && m.version) {
							// Published apps: icons load from the public `/appstore` assets
							// (PWA-precached), so the Dock has them offline without a round-trip.
							iconUrl = appFileUrl({ id: m.id, version: m.version }, m.icon)
						} else if (m.icon) {
							// Locally installed (devkit/zip) apps have no published assets; their
							// icon is stored verbatim as a self-describing data URL in the bundle.
							try {
								const bytes = await (await kernel.app(m.id)).read(m.icon)
								const text = new TextDecoder().decode(bytes)
								if (text.startsWith('data:')) iconUrl = text
							} catch {}
						}
						return {
							id: m.id,
							name: m.name,
							description: m.description ?? '',
							version: m.version,
							iconUrl
						}
					})
				)
			}
		})
	)
	const [{ store, flushPersist }] = useState(() =>
		createOsStore({
			appHost,
			getToken: () => getTokenRef.current(),
			send: client.send,
			volume: volumePromise,
			localKernel
		})
	)

	// All boot/subscription wiring is mount-once (its deps are stable singletons),
	// so it lives in the runtime rather than a fan of effects. Only the auth effect
	// below is genuinely reactive to Clerk state.
	useEffect(
		() => startOsRuntime({ store, client, flushPersist, volume: volumePromise, localKernel }),
		[store, client, flushPersist, volumePromise, localKernel]
	)

	// biome-ignore lint/correctness/useExhaustiveDependencies: backend sockets must reconnect when Clerk's session changes.
	useEffect(() => {
		// Auth is optional. Before/without a signed-in session, keep backend sockets
		// closed and let the client replay the local catalog.
		resetCapabilitySocket()
		if (!isLoaded || !isSignedIn) {
			client.close()
			return
		}
		client.connect()
		return () => {
			client.close()
			resetCapabilitySocket()
		}
	}, [client, isLoaded, isSignedIn, userId])

	const value = useMemo(
		() => ({ store, client, localKernel, volume: volumePromise }),
		[store, client, localKernel, volumePromise]
	)

	return <OsContext.Provider value={value}>{children}</OsContext.Provider>
}
