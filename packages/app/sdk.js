// Client-only app SDK. Installs `window.app` with a small, stable surface.
//
// Loaded as a plain script before app code (see hello/index.html). The host
// posts JSON-RPC notifications over MessageChannel/postMessage; this SDK
// listens for `app.lifecycle` events and fans them out to author-registered
// callbacks. Idempotent: a second load is a no-op so app authors can include
// it without worrying about double-injection.

;(function () {
	if (typeof window === 'undefined' || window.app) return

	const API_VERSION = 1
	const onStart = new Set()
	let started = false

	window.addEventListener('message', (event) => {
		if (event.source !== window.parent) return
		const data = event.data
		if (!data || typeof data !== 'object' || data.jsonrpc !== '2.0') return
		if (data.method !== 'app.lifecycle') return
		const params = data.params
		if (!params || typeof params !== 'object') return
		if (params.event === 'start' && !started) {
			started = true
			for (const cb of onStart) {
				try {
					cb()
				} catch (err) {
					console.error('app.lifecycle.onStart callback threw:', err)
				}
			}
			onStart.clear()
		}
	})

	const lifecycle = Object.freeze({
		onStart(callback) {
			if (typeof callback !== 'function') return () => {}
			if (started) {
				queueMicrotask(callback)
				return () => {}
			}
			onStart.add(callback)
			return () => onStart.delete(callback)
		}
	})

	window.app = Object.freeze({
		version: API_VERSION,
		lifecycle
	})
})()
