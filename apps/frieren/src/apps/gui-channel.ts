// The GUI runs inside a `sandbox="allow-scripts"` iframe — an opaque origin with
// no credentials, no cookies, and no reach into the host DOM. Its only authority
// is one MessagePort to the host kernel. The host stays trusted: it holds the
// other port and dispatches. Every message across the port is structured-clone
// data (an action in, a result/state out), so no closures cross the boundary.
//
// The reducer Worker still runs on the host in this step (Topology A); only the
// GUI moves into the frame. Step 4 relocates the reducer too.

import type { Message } from '@justfiles/app'

// guest→host: one request. host→guest: its reply, plus authoritative state pushes.
type GuestMessage = { type: 'invoke'; id: string; action: Message }
type HostMessage =
	| { type: 'invoked'; id: string; result: unknown }
	| { type: 'invokeError'; id: string; error: { message: string } }
	| { type: 'state'; state: unknown }

// The five React specifiers the GUI bundle externalises (see runtime-specs.ts),
// mapped to the host-served vendor bytes. The frame's importmap and this list
// must agree, so the frame bootstrap below repeats the same specifiers.
const VENDOR: Record<string, string> = {
	react: '/vendor/react.js',
	'react-dom': '/vendor/react-dom.js',
	'react-dom/client': '/vendor/react-dom-client.js',
	'react/jsx-runtime': '/vendor/jsx-runtime.js',
	'react/jsx-dev-runtime': '/vendor/jsx-dev-runtime.js'
}

let vendorCache: Promise<Record<string, string>> | undefined
let stylesCache: string | undefined

// Read the vendor React bytes once (same-origin to `/vendor`). Shipped into the
// frame so the opaque origin needs no network and no CORS; the frame builds its
// own blob-URL importmap over these five specifiers → one React per frame.
export function readVendor(): Promise<Record<string, string>> {
	vendorCache ??= (async () => {
		const entries = await Promise.all(
			Object.entries(VENDOR).map(
				async ([spec, url]) => [spec, await (await fetch(url)).text()] as const
			)
		)
		return Object.fromEntries(entries)
	})()
	return vendorCache
}

// Serialize the host's stylesheets once. Apps render with their own injected
// layout CSS but read the host's design tokens (design.css), which the opaque
// frame doesn't inherit — so we clone the host cascade in. Cross-origin sheets
// (Clerk) throw on `cssRules` and are skipped; `@font-face` rules are dropped
// since a null origin can't fetch host fonts (they only ever 404 CORS — the
// frame falls back to system fonts).
export function readHostStyles(): string {
	if (stylesCache !== undefined) return stylesCache
	let css = ''
	for (const sheet of Array.from(document.styleSheets)) {
		try {
			for (const rule of Array.from(sheet.cssRules)) {
				if (rule instanceof CSSFontFaceRule) continue
				css += `${rule.cssText}\n`
			}
		} catch {
			// cross-origin stylesheet — not readable, skip.
		}
	}
	stylesCache = css
	return css
}

// Host side: service the guest's invokes against `invoke` (a kernel dispatch)
// and return a `postState` the host's state sources call to push authoritative
// state to the guest. Fresh per frame load (a new port each boot).
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

// The frame document (a classic inline script, so a runtime-added importmap is
// legal — no module load has been triggered yet). On `boot` it receives the
// port, vendor bytes, host styles, gui bytes, and initial state; it injects the
// styles, stands up a blob-URL importmap, imports gui.js, and mounts it against
// a port-backed transport (`guiClient`, the guest twin of `guiHost`). Boot
// failures are reported to the host for the error overlay.
export const FRAME_SRCDOC = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;height:100%}#root{height:100%;overflow:hidden}</style>
<div id="root"></div>
<script>
(function () {
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
	function installImportmap(vendor) {
		var specs = ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime']
		var map = { imports: {} }
		specs.forEach(function (s) {
			map.imports[s] = URL.createObjectURL(new Blob([vendor[s]], { type: 'text/javascript' }))
		})
		var el = document.createElement('script')
		el.type = 'importmap'; el.textContent = JSON.stringify(map)
		document.head.appendChild(el)
	}
	window.addEventListener('message', async function (e) {
		if (!e.data || e.data.type !== 'boot') return
		var port = e.ports[0]
		try {
			if (e.data.styles) {
				var st = document.createElement('style'); st.textContent = e.data.styles
				document.head.appendChild(st)
			}
			installImportmap(e.data.vendor)
			var url = URL.createObjectURL(new Blob([e.data.guiCode], { type: 'text/javascript' }))
			var mod = await import(url)
			mod.gui.mount(document.getElementById('root'), e.data.state, { transport: guiClient(port) })
		} catch (err) {
			parent.postMessage({ type: 'error', message: String((err && err.message) || err) }, '*')
		}
	})
})()
</script>`
