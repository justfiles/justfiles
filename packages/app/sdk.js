// Client-only app SDK. Installs `window.app` with a small, stable surface.
//
// Loaded as a plain script before app code (see hello/index.html). The host
// posts JSON-RPC notifications and responses over MessageChannel/postMessage;
// this SDK fans lifecycle notifications to author-registered callbacks and
// correlates request/response frames for typed APIs (`volume`, …).
// Idempotent: a second load is a no-op so apps can include it without
// worrying about double-injection.

;(function () {
	if (typeof window === 'undefined' || window.app) return

	const API_VERSION = 1
	const onStart = new Set()
	const pending = new Map()
	let started = false
	let nextId = 0

	const isRecord = (v) => typeof v === 'object' && v !== null

	function uint8ToBase64(u8) {
		let bin = ''
		for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i])
		return btoa(bin)
	}

	function base64ToUint8(b64) {
		const bin = atob(b64)
		const u8 = new Uint8Array(bin.length)
		for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
		return u8
	}

	function request(method, params) {
		const id = `app-${++nextId}`
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject })
			window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*')
		})
	}

	window.addEventListener('message', (event) => {
		if (event.source !== window.parent) return
		const data = event.data
		if (!isRecord(data) || data.jsonrpc !== '2.0') return

		if (data.id != null && ('result' in data || 'error' in data)) {
			const id = String(data.id)
			const p = pending.get(id)
			if (!p) return
			pending.delete(id)
			if (isRecord(data.error)) {
				const err = new Error(String(data.error.message ?? 'rpc_error'))
				err.code = data.error.code
				p.reject(err)
			} else {
				p.resolve(data.result)
			}
			return
		}

		if (data.method !== 'app.lifecycle' || !isRecord(data.params)) return
		if (data.params.event === 'start' && !started) {
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

	const volume = Object.freeze({
		async readText(path) {
			const r = await request('app.volume.readText', { path })
			return r.text
		},
		async writeText(path, text) {
			await request('app.volume.writeText', { path, text })
		},
		async readFile(path) {
			const r = await request('app.volume.readFile', { path })
			return base64ToUint8(r.bytes)
		},
		async writeFile(path, bytes) {
			if (!(bytes instanceof Uint8Array)) throw new TypeError('bytes must be a Uint8Array')
			await request('app.volume.writeFile', { path, bytes: uint8ToBase64(bytes) })
		}
	})

	window.app = Object.freeze({
		version: API_VERSION,
		lifecycle,
		volume
	})
})()
