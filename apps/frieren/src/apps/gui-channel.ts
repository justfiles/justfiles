// A GUI talks to the host kernel only through a MessagePort: the host holds one
// port and dispatches; the guest holds the other, builds the app's typed client
// from it, and mounts. Every message is structured-clone data (an action in, a
// result/state out) — no closures cross. Two guest hosts share this protocol:
//
//   • in-realm (trusted built-ins): `bootGui` mounts the GUI in the host document
//     with `guiClient` as its transport. Full host-DOM access (needed by devkit's
//     live preview), shared React, no cold start.
//   • sandboxed iframe (untrusted apps): `FRAME_SRCDOC` runs the same guest logic
//     inside an opaque-origin `allow-scripts` frame whose only authority is the
//     port. It gets no cookies, no host DOM, and cannot read the token.
//
// The reducer Worker always runs on the host (Topology A).

import type { Message, Transport } from '@justfiles/app'

// guest→host: one request. host→guest: its reply, plus authoritative state pushes.
type GuestMessage = { type: 'invoke'; id: string; action: Message }
type HostMessage =
	| { type: 'invoked'; id: string; result: unknown }
	| { type: 'invokeError'; id: string; error: { message: string } }
	| { type: 'state'; state: unknown }

export interface GuiInstance {
	update(state: unknown): Promise<void> | void
	unmount(): Promise<void> | void
}

interface GuiModule {
	gui: { mount(el: HTMLElement, state: unknown, ctx: { transport: Transport }): GuiInstance }
}

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

// The host root's theme (frieren forces `class="dark" color-scheme:dark`). The
// frame's document doesn't inherit it, so `.dark`-scoped tokens (shadcn's
// --background/--foreground) would resolve light; the frame re-applies it.
export function hostTheme(): { className: string; colorScheme: string } {
	const el = document.documentElement
	return { className: el.className, colorScheme: el.style.colorScheme }
}

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

// Guest side (in-realm): a Transport over the port. `invoke` correlates
// request/reply by id (mirrors sandboxClient); `subscribe` fans state pushes.
// The iframe carries a source-text twin of this in FRAME_SRCDOC.
function guiClient(port: MessagePort): Transport {
	let nextId = 0
	const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
	const subscribers = new Set<(state: unknown) => void>()
	port.onmessage = (e) => {
		const msg = e.data as HostMessage
		if (msg.type === 'state') {
			for (const fn of subscribers) fn(msg.state)
			return
		}
		const p = pending.get(msg.id)
		if (!p) return
		pending.delete(msg.id)
		if (msg.type === 'invokeError') p.reject(new Error(msg.error.message))
		else p.resolve(msg.result)
	}
	return {
		invoke: (action) =>
			new Promise((resolve, reject) => {
				const id = String(nextId++)
				pending.set(id, { resolve, reject })
				port.postMessage({ type: 'invoke', id, action } satisfies GuestMessage)
			}),
		subscribe: (onState) => {
			subscribers.add(onState)
			return () => void subscribers.delete(onState)
		}
	}
}

// In-realm guest bootstrap: load the GUI bytes and mount them in the host
// document against a port-backed client.
export async function bootGui(input: {
	el: HTMLElement
	port: MessagePort
	guiCode: string
	state: unknown
}): Promise<GuiInstance> {
	const url = URL.createObjectURL(new Blob([input.guiCode], { type: 'application/javascript' }))
	let mod: GuiModule
	try {
		mod = (await import(/* @vite-ignore */ url)) as GuiModule
	} finally {
		URL.revokeObjectURL(url)
	}
	return mod.gui.mount(input.el, input.state, { transport: guiClient(input.port) })
}

// The frame document (a classic inline script, so a runtime-added importmap is
// legal — no module load has been triggered yet). On `boot` it receives the
// port, vendor bytes, host styles + theme, gui bytes, and initial state; it
// applies the theme, injects the styles, stands up a blob-URL importmap, imports
// gui.js, and mounts it against a port-backed transport (the guest twin of
// `guiHost`). Boot failures are reported to the host for the error overlay.
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
			if (e.data.theme) {
				document.documentElement.className = e.data.theme.className
				document.documentElement.style.colorScheme = e.data.theme.colorScheme
			}
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
