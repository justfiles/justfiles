import { useAuth } from '@clerk/clerk-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import * as appHost from '../apps/host'
import { createFsVolume } from '../fs'
import { type OsClient, OsContext } from './hooks'
import { bootOsStore, createOsStore } from './store'

function createOsClient(): OsClient {
	let sendImpl: (frame: object) => void = () => {}
	let guiUrlForImpl: (appId: string) => string | undefined = () => undefined

	return {
		send: (frame) => sendImpl(frame),
		guiUrlFor: (appId) => guiUrlForImpl(appId),
		setSend: (send) => {
			sendImpl = send
			return () => {
				if (sendImpl === send) sendImpl = () => {}
			}
		},
		setGuiUrlFor: (guiUrlFor) => {
			guiUrlForImpl = guiUrlFor
			return () => {
				if (guiUrlForImpl === guiUrlFor) guiUrlForImpl = () => undefined
			}
		}
	}
}

export function OSProvider({ children }: { children: ReactNode }) {
	const { getToken } = useAuth()
	const getTokenRef = useRef(getToken)
	getTokenRef.current = getToken

	const [client] = useState(() => createOsClient())
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

	const value = useMemo(() => ({ store, client }), [store, client])

	return <OsContext.Provider value={value}>{children}</OsContext.Provider>
}
