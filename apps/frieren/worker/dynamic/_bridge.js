// Loaded inside every dynamic-app iframe (auto-injected into served HTML by
// the asset endpoint). Exposes `window.app.{state, subscribe, dispatch}` and
// pipes JSON-RPC over postMessage to the supervisor host.
//
// The host responds to `app.ready` with the current state and pushes
// `app.state` notifications on every transition. `app.action` calls travel the
// other direction: iframe → host → facet.dispatch.

;(function () {
	const pending = new Map()
	const listeners = new Set()
	let nextId = 0
	let currentState

	function isRecord(value) {
		return typeof value === 'object' && value !== null
	}

	function notify(state) {
		currentState = state
		for (const listener of listeners) listener(state)
	}

	function call(method, params) {
		const id = String(++nextId)
		window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*')
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject })
		})
	}

	window.addEventListener('message', (event) => {
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

	window.app = {
		get state() {
			return currentState
		},
		subscribe(listener) {
			listeners.add(listener)
			if (currentState !== undefined) listener(currentState)
			return () => listeners.delete(listener)
		},
		async dispatch(action) {
			await call('app.action', { action })
		}
	}

	void call('app.ready', {}).then((result) => {
		if (isRecord(result) && 'state' in result) notify(result.state)
	})
})()
