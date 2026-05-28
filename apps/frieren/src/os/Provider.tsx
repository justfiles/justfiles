import { useAuth } from '@clerk/clerk-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import * as appHost from '../apps/host'
import { createFsVolume } from '../fs'
import { createFrierenClient } from './client'
import { OsContext } from './hooks'
import { bootOsStore, createOsStore } from './store'

export function OSProvider({ children }: { children: ReactNode }) {
	const { getToken } = useAuth()
	const getTokenRef = useRef(getToken)
	getTokenRef.current = getToken

	const [client] = useState(() => createFrierenClient({ getToken: () => getTokenRef.current() }))
	const [volumePromise] = useState(() => createFsVolume(() => getTokenRef.current()))
	const [{ store, flushPersist }] = useState(() =>
		createOsStore({
			appHost,
			getToken: () => getTokenRef.current(),
			guiUrlFor: client.guiUrlFor,
			send: client.send,
			volume: volumePromise
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
		}
	}, [client, store])

	const value = useMemo(() => ({ store, client }), [store, client])

	return <OsContext.Provider value={value}>{children}</OsContext.Provider>
}
