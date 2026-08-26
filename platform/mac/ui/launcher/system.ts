import { useEffect, useState } from 'react'

// The daemon's `/system` socket: the installed-app catalog, pushed on connect and on every
// change. Shared by the launcher and the App Store page (which needs it to tell an
// installed app from an offer).

export type Capabilities = Record<string, { id: string; scopes: string[] }>

// One installed app, as the daemon's catalog frame carries it (an `AppManifest`, of which
// this is the part the launcher and the store read).
export interface App {
	id: string
	name: string
	description?: string
	icon?: string
	version?: string
	capabilities?: Capabilities
}

type SystemMessage = { type: 'apps'; apps: App[] } | { type: 'error'; message: string }

export type Connection = 'connecting' | 'ready' | 'disconnected'

export function useSystemApps(): { apps: App[]; connection: Connection; error: string | null } {
	const [apps, setApps] = useState<App[]>([])
	const [connection, setConnection] = useState<Connection>('connecting')
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		let stopped = false
		let retry: ReturnType<typeof setTimeout> | undefined
		let socket: WebSocket | undefined

		const connect = () => {
			setConnection('connecting')
			socket = new WebSocket(
				`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/system`
			)
			socket.onopen = () => {
				setError(null)
			}
			socket.onmessage = (event) => {
				const message = JSON.parse(String(event.data)) as SystemMessage
				if (message.type === 'apps') {
					setApps(message.apps)
					setConnection('ready')
					setError(null)
				} else if (message.type === 'error') {
					setError(message.message)
				}
			}
			socket.onerror = () => socket?.close()
			socket.onclose = () => {
				if (stopped) return
				setConnection('disconnected')
				retry = setTimeout(connect, 1000)
			}
		}

		connect()
		return () => {
			stopped = true
			clearTimeout(retry)
			socket?.close()
		}
	}, [])

	return { apps, connection, error }
}
