// Client-only app SDK. Installs `window.app` with a small, stable surface.
//
// Loaded as a plain script before app code (auto-injected by the host into
// client-only app HTML). The host posts JSON-RPC notifications and replies
// over MessageChannel/postMessage; this SDK listens for `app.lifecycle`
// events and dispatches request/response calls (volume, …) to the parent.
// Idempotent: a second load is a no-op so authors can include it without
// worrying about double-injection.

;(function () {
	if (typeof window === 'undefined' || window.app) return

	const API_VERSION = 1
	const onStart = new Set()
	let started = false

	const pending = new Map()
	let nextId = 0

	function call(method, params) {
		const id = `r${++nextId}`
		const frame = { jsonrpc: '2.0', id, method, params }
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject })
			window.parent.postMessage(frame, '*')
		})
	}

	function isRecord(value) {
		return typeof value === 'object' && value !== null
	}

	function handleResponse(message) {
		const id = String(message.id)
		const entry = pending.get(id)
		if (!entry) return
		pending.delete(id)
		if (isRecord(message.error)) {
			entry.reject(new Error(String(message.error.message ?? 'unknown error')))
		} else {
			entry.resolve(message.result)
		}
	}

	function handleNotification(data) {
		if (data.method !== 'app.lifecycle') return
		const params = data.params
		if (!isRecord(params)) return
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
	}

	window.addEventListener('message', (event) => {
		if (event.source !== window.parent) return
		const data = event.data
		if (!isRecord(data) || data.jsonrpc !== '2.0') return
		if ('id' in data && ('result' in data || 'error' in data)) {
			handleResponse(data)
			return
		}
		if (typeof data.method === 'string') handleNotification(data)
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

	// JSON-RPC carries no native binary type; binary file payloads cross the
	// boundary as base64 strings. The SDK encodes/decodes so authors deal in
	// Uint8Array on both sides.
	function uint8ToBase64(bytes) {
		let str = ''
		for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i])
		return btoa(str)
	}

	function base64ToUint8(b64) {
		const str = atob(b64)
		const out = new Uint8Array(str.length)
		for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i)
		return out
	}

	const volume = Object.freeze({
		async readText(path) {
			if (typeof path !== 'string') throw new TypeError('readText: path must be a string')
			const result = await call('app.volume.readText', { path })
			return String(result)
		},
		async writeText(path, data) {
			if (typeof path !== 'string') throw new TypeError('writeText: path must be a string')
			if (typeof data !== 'string') throw new TypeError('writeText: data must be a string')
			await call('app.volume.writeText', { path, data })
		},
		async readFile(path) {
			if (typeof path !== 'string') throw new TypeError('readFile: path must be a string')
			const result = await call('app.volume.readFile', { path })
			if (typeof result !== 'string') throw new TypeError('readFile: bad host response')
			return base64ToUint8(result)
		},
		async writeFile(path, bytes) {
			if (typeof path !== 'string') throw new TypeError('writeFile: path must be a string')
			if (!(bytes instanceof Uint8Array)) {
				throw new TypeError('writeFile: bytes must be a Uint8Array')
			}
			await call('app.volume.writeFile', { path, bytes: uint8ToBase64(bytes) })
		}
	})

	window.app = Object.freeze({
		version: API_VERSION,
		lifecycle,
		volume
	})
})()
