import { useAuth } from '@clerk/clerk-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { appFileUrl } from '../../shared/appstore'
import { resetCapabilitySocket } from '../apps/capabilities.client'
import * as appHost from '../apps/host'
import { hydrateInstalledAppBundles } from '../apps/hydrate'
import { createClientKernel } from '../apps/kernel.client'
import type { InstalledApp } from '../apps/types'
import { getFsVolume } from '../fs'
import { createFrierenClient } from './client'
import { OsContext } from './hooks'
import { bootOsStore, createOsStore } from './store'

export function OSProvider({ children }: { children: ReactNode }) {
	const { getToken, userId } = useAuth()
	const getTokenRef = useRef(getToken)
	getTokenRef.current = getToken

	// The provider only mounts for a signed-in, onboarded user, so userId is set;
	// the singleton hands back the same replica App created during onboarding.
	const [volumePromise] = useState(() => {
		if (!userId) throw new Error('OSProvider requires a signed-in user')
		return getFsVolume(userId, () => getTokenRef.current())
	})
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
			listLocalApps: async (): Promise<InstalledApp[]> =>
				(await (await localKernel()).list()).map((m) => ({
					id: m.id,
					name: m.name,
					description: m.description ?? '',
					// Icons load from the public `/appstore` assets (PWA-precached), so
					// the Dock has them offline without a server round-trip.
					iconUrl:
						m.icon && m.version ? appFileUrl({ id: m.id, version: m.version }, m.icon) : undefined
				}))
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

	useEffect(() => {
		void bootOsStore(store, volumePromise)
	}, [store, volumePromise])

	useEffect(() => {
		let cancelled = false
		let running = false
		let pending = false
		const hydrate = () => {
			if (cancelled) return
			// Coalesce overlapping requests, but remember a catalog change that
			// arrived mid-run so a newly-installed app still gets prefetched.
			if (running) {
				pending = true
				return
			}
			running = true
			void hydrateInstalledAppBundles(localKernel)
				.catch(() => {})
				.finally(() => {
					running = false
					if (pending && !cancelled) {
						pending = false
						hydrate()
					}
				})
		}
		hydrate()
		const unsubscribe = client.subscribeApps(hydrate)
		return () => {
			cancelled = true
			unsubscribe()
		}
	}, [client, localKernel])

	useEffect(() => {
		// OS state is authoritative client-side shell state, so don't rely on
		// unload alone: prompt writes happen on commit, and this flushes any
		// pending geometry write before the tab goes away or the provider unmounts.
		const onHidden = () => {
			if (document.visibilityState === 'hidden') flushPersist()
		}
		window.addEventListener('pagehide', flushPersist)
		document.addEventListener('visibilitychange', onHidden)
		return () => {
			window.removeEventListener('pagehide', flushPersist)
			document.removeEventListener('visibilitychange', onHidden)
			flushPersist()
		}
	}, [flushPersist])

	useEffect(() => {
		// Server-echoed app open/close drive the OS store as remote actions. Wire
		// the handler before connecting so an early live open isn't missed. Queue
		// it until local OS state has booted; otherwise server opens briefly create
		// default-rect windows before the persisted rects load.
		const pending: Parameters<typeof store.dispatch>[0][] = []
		const flushPending = () => {
			if (!store.getState().booted) return
			for (const action of pending.splice(0)) store.dispatch(action)
		}
		const unsubscribeRemote = client.onRemoteWindow((action) => {
			if (!store.getState().booted) {
				pending.push(action)
				return
			}
			store.dispatch(action)
		})
		const unsubscribeStore = store.subscribe(flushPending)
		client.connect()
		return () => {
			unsubscribeRemote()
			unsubscribeStore()
			client.close()
			// App GUI hosting is part of OS lifecycle: drop every stage so a
			// previous session's DOM doesn't survive sign-out / user switch.
			appHost.closeAll()
			// Drop the shared capability-proxy socket for the same reason.
			resetCapabilitySocket()
		}
	}, [client, store])

	const value = useMemo(() => ({ store, client }), [store, client])

	return <OsContext.Provider value={value}>{children}</OsContext.Provider>
}
