// Author-transparent bridge. Installs `window.app` on import.
//
// Transport is auto-selected:
//   - frieren prod: app runs in a sandboxed iframe; talk to window.parent
//     over postMessage (chat client shuttles frames to the host DO).
//   - dev harness: app runs as the top-level page; open a WebSocket to
//     `/__app` on the same origin where serveApp is listening.
//
// Both transports speak the same JSON-RPC frames (see protocol.ts).

;(function () {
	// Idempotent: if a previous load already installed window.app (e.g. the host
	// auto-injected the bridge AND the bundled frontend imports it), skip.
	if (window.app) return

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

	function handleIncoming(message) {
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
			return
		}
		if (message.method === 'app.print') {
			window.focus()
			window.print()
		}
	}

	const inIframe = window.parent !== window
	const send = inIframe ? sendViaPostMessage() : sendViaWebSocket()
	const panel = inIframe ? null : mountAgentPanel()

	function sendViaPostMessage() {
		window.addEventListener('message', (event) => handleIncoming(event.data))
		return (frame) => window.parent.postMessage(frame, '*')
	}

	function sendViaWebSocket() {
		const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
		const ws = new WebSocket(`${proto}//${location.host}/__app`)
		const queue = []
		let open = false
		ws.addEventListener('open', () => {
			open = true
			for (const frame of queue) ws.send(JSON.stringify(frame))
			queue.length = 0
		})
		ws.addEventListener('message', (event) => {
			try {
				handleIncoming(JSON.parse(event.data))
			} catch {}
		})
		ws.addEventListener('close', () => {
			open = false
			for (const { reject } of pending.values()) reject(new Error('socket closed'))
			pending.clear()
		})
		return (frame) => {
			if (open) ws.send(JSON.stringify(frame))
			else queue.push(frame)
		}
	}

	function call(method, params) {
		const id = String(++nextId)
		const frame = { jsonrpc: '2.0', id, method, params }
		send(frame)
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject })
		})
	}

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
			const result = await call('app.action', { action })
			if (isRecord(result) && result.ok === false) panel?.log(`✗ ${result.error}`)
			else if (isRecord(result) && typeof result.narration === 'string')
				panel?.log(result.narration)
			return result
		}
	}

	void call('app.ready', {}).then((result) => {
		if (!isRecord(result)) return
		if ('state' in result) notify(result.state)
		if (typeof result.briefing === 'string' && result.briefing) panel?.log(result.briefing)
	})

	// Dev-only floating panel — shows what the agent would see (briefing on
	// launch, narration after each dispatch). Not mounted when running inside
	// frieren's iframe; there the LLM consumes these directly.
	function mountAgentPanel() {
		const root = document.createElement('aside')
		root.style.cssText =
			'position:fixed;right:8px;bottom:8px;max-width:360px;max-height:50vh;overflow:auto;' +
			'padding:8px 12px;background:rgb(15 23 42 / 0.92);color:#e0f2fe;border:1px solid #334155;' +
			'border-radius:6px;font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;' +
			'z-index:2147483647'
		const log = document.createElement('div')
		root.append(log)
		document.body
			? document.body.append(root)
			: window.addEventListener('DOMContentLoaded', () => document.body.append(root))
		return {
			log(text) {
				const entry = document.createElement('div')
				entry.style.borderTop = log.childNodes.length ? '1px solid #334155' : 'none'
				entry.style.paddingTop = log.childNodes.length ? '6px' : '0'
				entry.style.marginTop = log.childNodes.length ? '6px' : '0'
				entry.textContent = text
				log.append(entry)
				root.scrollTop = root.scrollHeight
			}
		}
	}
})()
