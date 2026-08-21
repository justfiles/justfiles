import type { Message } from './app.ts'

type HostMessage =
	| { type: 'invoked'; id: string; result: unknown }
	| { type: 'invokeError'; id: string; error: { message: string } }
	| { type: 'state'; state: unknown }

/** Connect a sandboxed app GUI's message port to its host kernel. */
export function guiHost(
	port: MessagePort,
	host: {
		invoke: (action: Message) => Promise<unknown>
		onError?: (message: string) => void
		onMessage?: (message: Record<string, unknown>) => void
	}
): (state: unknown) => void {
	port.onmessage = (event: MessageEvent) => {
		const message = event.data as unknown
		if (!isRecord(message) || typeof message.type !== 'string') return
		if (message.type === 'error') {
			if (typeof message.message === 'string') host.onError?.(message.message)
			return
		}
		if (message.type !== 'invoke') {
			host.onMessage?.(message)
			return
		}
		if (
			typeof message.id !== 'string' ||
			!isRecord(message.action) ||
			typeof message.action.type !== 'string'
		)
			return

		const id = message.id
		const action = message.action as Message
		void (async () => {
			try {
				const result = await host.invoke(action)
				port.postMessage({
					type: 'invoked',
					id,
					result
				} satisfies HostMessage)
			} catch (error) {
				port.postMessage({
					type: 'invokeError',
					id,
					error: { message: error instanceof Error ? error.message : String(error) }
				} satisfies HostMessage)
			}
		})()
	}

	return (state) => port.postMessage({ type: 'state', state } satisfies HostMessage)
}

/** Embed this trusted boot script in the sandboxed iframe document supplied by the host. */
export const guiFrameScript = `(function () {
	var booted = false
	function guiClient(port) {
		var nextId = 0, pending = new Map(), subscribers = new Set()
		port.onmessage = function (event) {
			var message = event.data
			if (!message || typeof message !== 'object') return
			if (message.type === 'state') {
				subscribers.forEach(function (subscriber) { subscriber(message.state) })
				return
			}
			var request = pending.get(message.id)
			if (!request) return
			if (message.type === 'invokeError') {
				pending.delete(message.id)
				request.reject(new Error(message.error.message))
			} else if (message.type === 'invoked') {
				pending.delete(message.id)
				request.resolve(message.result)
			}
		}
		return {
			invoke: function (action) {
				return new Promise(function (resolve, reject) {
					var id = String(nextId++)
					pending.set(id, { resolve: resolve, reject: reject })
					port.postMessage({ type: 'invoke', id: id, action: action })
				})
			},
			subscribe: function (subscriber) {
				subscribers.add(subscriber)
				return function () { subscribers.delete(subscriber) }
			}
		}
	}
	window.addEventListener('message', async function (event) {
		if (event.source !== parent || !event.data || event.data.type !== 'boot' || booted) return
		var port = event.ports[0]
		if (!port) return
		booted = true
		try {
			var url = event.data.guiUrl, revoke = false
			if (!url) {
				url = URL.createObjectURL(new Blob([event.data.guiCode], { type: 'text/javascript' }))
				revoke = true
			}
			var module
			try { module = await import(url) } finally { if (revoke) URL.revokeObjectURL(url) }
			await module.gui.mount(document.getElementById('root'), event.data.state, {
				transport: guiClient(port)
			})
		} catch (error) {
			port.postMessage({
				type: 'error',
				message: String((error && error.message) || error)
			})
		}
	})
})()`

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}
