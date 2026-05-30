import { useAuth } from '@clerk/clerk-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { resetCapabilitySocket } from '../apps/capabilities.client'
import { shouldUseLocalKernel } from '../apps/flags'
import * as appHost from '../apps/host'
import { createClientKernel } from '../apps/kernel.client'
import { getFsVolume } from '../fs'
import { createFrierenClient } from './client'
import { OsContext } from './hooks'
import { bootOsStore, createOsStore } from './store'

export function OSProvider({ children }: { children: ReactNode }) {
	const { getToken, userId } = useAuth()
	const getTokenRef = useRef(getToken)
	getTokenRef.current = getToken

	const [client] = useState(() => createFrierenClient({ getToken: () => getTokenRef.current() }))
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
	const [{ store, flushPersist }] = useState(() =>
		createOsStore({
			appHost,
			getToken: () => getTokenRef.current(),
			guiUrlFor: client.guiUrlFor,
			send: client.send,
			volume: volumePromise,
			localKernel,
			shouldUseLocalKernel
		})
	)

	useEffect(() => {
		void bootOsStore(store, volumePromise)
	}, [store, volumePromise])

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
