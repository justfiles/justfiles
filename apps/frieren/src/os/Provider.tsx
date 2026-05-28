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
	const [store] = useState(() =>
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
		// Server-echoed app open/close drive the OS store as remote actions. Wire
		// the handler before connecting so a replayed open isn't missed.
		const unsubscribe = client.onRemoteWindow((action) => store.dispatch(action))
		client.connect()
		return () => {
			unsubscribe()
			client.close()
		}
	}, [client, store])

	const value = useMemo(() => ({ store, client }), [store, client])

	return <OsContext.Provider value={value}>{children}</OsContext.Provider>
}
