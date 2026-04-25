// Injected into sandboxed app iframes as `window.app`. Mirrors the shape of
// `window.chrome.*` in browser extensions: a singleton the app can call to
// read state, subscribe to updates, and dispatch actions back to the host.
//
// Transport is JSON-RPC over postMessage; the app never sees it. State is
// pushed once on ready and again on every host dispatch.

export type AppClient<State, Action> = {
	readonly state: State | undefined
	subscribe(listener: (state: State) => void): () => void
	dispatch(action: Action): Promise<void>
}

type HostWindow = {
	app?: unknown
	parent: { postMessage(message: unknown, targetOrigin: string): void }
	addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
}

function appClientRuntime() {
	const host = globalThis as unknown as HostWindow

	function isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === 'object' && value !== null
	}

	const pending = new Map<
		string,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>()
	const listeners = new Set<(state: unknown) => void>()
	let nextId = 0
	let currentState: unknown

	function notify(state: unknown) {
		currentState = state
		for (const listener of listeners) listener(state)
	}

	function call(method: string, params?: unknown): Promise<unknown> {
		const id = String(++nextId)
		host.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*')
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject })
		})
	}

	host.addEventListener('message', (event) => {
		const message = event.data
		if (!isRecord(message) || message.jsonrpc !== '2.0') return

		if ('id' in message && ('result' in message || 'error' in message)) {
			const id = String(message.id)
			const request = pending.get(id)
			if (!request) return
			pending.delete(id)
			if (isRecord(message.error)) request.reject(new Error(String(message.error.message)))
			else request.resolve(message.result)
			return
		}

		if (message.method === 'app.state' && isRecord(message.params)) {
			notify(message.params.state)
		}
	})

	host.app = {
		get state() {
			return currentState
		},
		subscribe(listener: (state: unknown) => void) {
			listeners.add(listener)
			if (currentState !== undefined) listener(currentState)
			return () => {
				listeners.delete(listener)
			}
		},
		async dispatch(action: unknown) {
			await call('app.action', { action })
		}
	}

	void call('app.ready', {}).then((result) => {
		if (isRecord(result) && 'state' in result) notify(result.state)
	})
}

export const appClientScript = `(${appClientRuntime.toString()})();`
