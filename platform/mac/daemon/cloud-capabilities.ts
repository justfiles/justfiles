import {
	type Capabilities,
	CapabilityError,
	proxyCapabilitiesRpc,
	wsFeedTransport
} from '@justfiles/app/capabilities'
import { capsWsProtocols } from '../../frieren/shared/caps-ws.ts'

export function cloudCapabilities(deps: {
	origin: string
	getToken(): Promise<string | null>
}): Capabilities & { dispose(): void } {
	let current:
		| {
				token: string
				socket: WebSocket
				connection: Promise<ReturnType<typeof proxyCapabilitiesRpc>>
		  }
		| undefined
	function dispose() {
		const previous = current
		current = undefined
		previous?.socket.close()
		void previous?.connection.then((proxy) => proxy.dispose()).catch(() => {})
	}
	async function connect(token: string) {
		if (current?.token === token && current.socket.readyState <= WebSocket.OPEN)
			return current.connection
		dispose()
		const url = new URL('/api/apps/_caps/ws', deps.origin)
		url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
		const socket = new WebSocket(url, capsWsProtocols(token))
		const connection = new Promise<ReturnType<typeof proxyCapabilitiesRpc>>((resolve, reject) => {
			const timer = setTimeout(() => {
				socket.close()
				reject(new Error('Cloud connection timed out.'))
			}, 15_000)
			const failed = () => {
				clearTimeout(timer)
				reject(new Error('Could not connect to Frieren.'))
			}
			socket.addEventListener('error', failed, { once: true })
			socket.addEventListener('close', failed, { once: true })
			socket.addEventListener(
				'open',
				() => {
					clearTimeout(timer)
					const { transport, feed } = wsFeedTransport(socket)
					socket.addEventListener('message', (e) => feed(e.data as string))
					const abort = () => transport.abort?.(new Error('Cloud connection closed.'))
					socket.addEventListener('close', abort)
					socket.addEventListener('error', abort)
					const proxy = proxyCapabilitiesRpc(transport)
					proxy.onBroken(() => {
						if (current?.socket === socket) dispose()
					})
					resolve(proxy)
				},
				{ once: true }
			)
		})
		current = { token, socket, connection }
		try {
			return await connection
		} catch (error) {
			if (current?.socket === socket) dispose()
			throw error
		}
	}
	return {
		dispose,
		invoke: async (call) => {
			const token = await deps.getToken()
			if (!token) {
				dispose()
				if (
					call.capability === 'settings' &&
					['accounts.listAccounts', 'accounts.listProviders'].includes(call.method)
				)
					return []
				throw new CapabilityError('CAPABILITY_UNAVAILABLE', call.capability, call.method)
			}
			return (await connect(token)).caps.invoke(call)
		},
		subscribe: async (call, emit) => {
			const token = await deps.getToken()
			if (!token) throw new CapabilityError('CAPABILITY_UNAVAILABLE', call.capability, call.method)
			return (await connect(token)).caps.subscribe(call, emit)
		}
	}
}
