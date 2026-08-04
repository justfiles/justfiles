// A GUI talks to the host kernel only through a MessagePort inside a
// `sandbox="allow-scripts"` opaque-origin iframe. It gets no cookies, no host
// DOM, and cannot read the token; its only authority is the port. Every message
// is structured-clone data (an action in, a result/state out), so no closures
// cross. A CSP on the frame document (below) makes its network deny-by-default.
// The reducer Worker runs in its own hidden opaque-origin frame (Topology B, see
// sandbox.worker.ts), so neither half of an app can `fetch` with credentials.
//
// Every app renders this way — built-ins included — so first-party developers hit
// the same sandbox limits their users will. The one thing that needed host-DOM
// access, app-code's live preview, is now a separate window (see devkit.client).

import type { Message } from '@justfiles/app'
// The platform sheet, inlined at build time (`?inline` resolves its `@import` of
// design.css into one string). It is baked into the frame document below rather
// than bundled into any app: a platform restyle then reaches every app on next
// load, with nothing to recompile or republish.
import macCss from '@justfiles/design/mac.css?inline'

// guest→host: one request. host→guest: its reply, plus authoritative state pushes.
type GuestMessage = { type: 'invoke'; id: string; action: Message }
type HostMessage =
	| { type: 'invoked'; id: string; result: unknown }
	| { type: 'invokeError'; id: string; error: { message: string } }
	| { type: 'state'; state: unknown }

// Host side: service the guest's invokes against `invoke` (a kernel dispatch)
// and return a `postState` the host's state sources call to push authoritative
// state to the guest.
export function guiHost(
	port: MessagePort,
	invoke: (action: Message) => Promise<unknown>
): (state: unknown) => void {
	port.onmessage = (e) => {
		const msg = e.data as GuestMessage
		if (msg.type !== 'invoke') return
		invoke(msg.action).then(
			(result) => port.postMessage({ type: 'invoked', id: msg.id, result } satisfies HostMessage),
			(error) =>
				port.postMessage({
					type: 'invokeError',
					id: msg.id,
					error: { message: error instanceof Error ? error.message : String(error) }
				} satisfies HostMessage)
		)
	}
	return (state) => port.postMessage({ type: 'state', state } satisfies HostMessage)
}

// The frame document carries the platform sheet up front, so an app that writes
// plain `<button>`/`<input>` looks native without
// asking for anything; every rule in it is `:where()`-wrapped, so the app's own
// CSS outranks it. Dark mode rides along via design.css's
// `@media (prefers-color-scheme)` plus its `color-scheme: light dark` (which also
// themes UA controls and scrollbars) — nothing to plumb through the port.
//
// On `boot` the frame receives the port, gui bytes, and initial state; it imports
// gui.js off a blob URL and mounts it against a port-backed transport (the guest
// twin of `guiHost`). The bundle is self-contained — it carries whatever framework
// it uses — so there is nothing to resolve and no importmap to install. Boot
// failures are reported to the host for the error overlay.
export const FRAME_SRCDOC = `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'">
<style>${macCss}</style>
<style>html,body{margin:0;height:100%}#root{height:100%;overflow:hidden}</style>
<div id="root"></div>
<script>
(function () {
	var booted = false
	function guiClient(port) {
		var nextId = 0, pending = new Map(), subs = new Set()
		port.onmessage = function (e) {
			var m = e.data
			if (m.type === 'state') { subs.forEach(function (fn) { fn(m.state) }); return }
			var p = pending.get(m.id); if (!p) return; pending.delete(m.id)
			if (m.type === 'invokeError') p.reject(new Error(m.error.message)); else p.resolve(m.result)
		}
		return {
			invoke: function (action) {
				return new Promise(function (resolve, reject) {
					var id = String(nextId++)
					pending.set(id, { resolve: resolve, reject: reject })
					port.postMessage({ type: 'invoke', id: id, action: action })
				})
			},
			subscribe: function (onState) { subs.add(onState); return function () { subs.delete(onState) } }
		}
	}
	window.addEventListener('message', async function (e) {
		if (!e.data || e.data.type !== 'boot' || booted) return
		booted = true
		var port = e.ports[0]
		try {
			// The gui bundle is imported once; free its blob URL as soon as the module
			// graph resolves.
			var url = URL.createObjectURL(new Blob([e.data.guiCode], { type: 'text/javascript' }))
			var mod
			try { mod = await import(url) } finally { URL.revokeObjectURL(url) }
			mod.gui.mount(document.getElementById('root'), e.data.state, { transport: guiClient(port) })
		} catch (err) {
			parent.postMessage({ type: 'error', message: String((err && err.message) || err) }, '*')
		}
	})
})()
</script>`
