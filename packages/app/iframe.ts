import type { Message } from './app.ts'
import type { DialogRequest } from './dialog.ts'

type HostMessage =
	| { type: 'invoked'; id: string; result: unknown }
	| { type: 'invokeError'; id: string; error: { message: string } }
	| { type: 'dialogResult'; id: string; result: unknown }
	| { type: 'dialogError'; id: string; error: { message: string } }
	| { type: 'state'; state: unknown }

/** Connect a sandboxed app GUI's message port to its host kernel. */
export function guiHost(
	port: MessagePort,
	host: {
		invoke: (action: Message) => Promise<unknown>
		dialog?: (request: DialogRequest) => Promise<unknown>
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
		if (message.type === 'dialog') {
			if (typeof message.id !== 'string') return
			const id = message.id
			const request = readDialogRequest(message.request)
			void (async () => {
				try {
					if (!request || !host.dialog) throw new Error('Dialog request is not supported')
					const result = await host.dialog(request)
					port.postMessage({ type: 'dialogResult', id, result } satisfies HostMessage)
				} catch (error) {
					port.postMessage({
						type: 'dialogError',
						id,
						error: { message: error instanceof Error ? error.message : String(error) }
					} satisfies HostMessage)
				}
			})()
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
			if (message.type === 'invokeError' || message.type === 'dialogError') {
				pending.delete(message.id)
				request.reject(new Error(message.error.message))
			} else if (message.type === 'invoked' || message.type === 'dialogResult') {
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
			request: function (request) {
				return new Promise(function (resolve, reject) {
					var id = String(nextId++)
					pending.set(id, { resolve: resolve, reject: reject })
					port.postMessage({ type: 'dialog', id: id, request: request })
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
			var client = guiClient(port)
			await module.gui.mount(document.getElementById('root'), event.data.state, {
				transport: client,
				dialog: client
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

function hasOnly(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key))
}

function isText(value: unknown, max: number): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= max
}

function hasContent(value: Record<string, unknown>): boolean {
	return (
		isText(value.title, 200) &&
		(value.body === undefined || (typeof value.body === 'string' && value.body.length <= 4_000))
	)
}

function readDialogRequest(value: unknown): DialogRequest | null {
	if (!isRecord(value) || !hasContent(value)) return null
	if (value.kind === 'alert' && hasOnly(value, ['kind', 'title', 'body']))
		return value as unknown as DialogRequest
	if (
		value.kind === 'confirm' &&
		hasOnly(value, ['kind', 'title', 'body', 'confirmLabel', 'destructive']) &&
		isText(value.confirmLabel, 80) &&
		(value.destructive === undefined || typeof value.destructive === 'boolean')
	)
		return value as unknown as DialogRequest
	if (
		value.kind !== 'choose' ||
		!hasOnly(value, ['kind', 'title', 'body', 'actions']) ||
		!Array.isArray(value.actions) ||
		value.actions.length < 1 ||
		value.actions.length > 3
	)
		return null
	const ids = new Set<string>()
	for (const action of value.actions) {
		if (
			!isRecord(action) ||
			!hasOnly(action, ['id', 'label', 'role']) ||
			!isText(action.id, 100) ||
			!isText(action.label, 80) ||
			(action.role !== undefined && action.role !== 'cancel' && action.role !== 'destructive') ||
			ids.has(action.id)
		)
			return null
		ids.add(action.id)
	}
	return value as unknown as DialogRequest
}
