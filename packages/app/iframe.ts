import macCss from '@justfiles/design/mac.css?inline'
import { guiFrameScript, guiHost } from './iframe-bridge.ts'

export { guiFrameScript, guiHost } from './iframe-bridge.ts'

/** Mount the same opaque-origin GUI document in every app host. */
export function mountAppFrame(
	container: HTMLElement,
	guiCode: string,
	state: unknown,
	host: Parameters<typeof guiHost>[1]
) {
	const frame = document.createElement('iframe')
	frame.title = 'App'
	frame.style.cssText = 'display:block;width:100%;height:100%;border:0'
	frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-downloads')
	frame.srcdoc = FRAME_SRCDOC
	let bridge: ReturnType<typeof guiHost> | undefined
	let disposed = false
	const boot = () => {
		if (disposed || !frame.isConnected) return
		bridge?.dispose()
		const target = frame.contentWindow!
		const connected = () => frame.isConnected && frame.contentWindow === target
		const { port1, port2 } = new MessageChannel()
		bridge = guiHost(port1, {
			onError: (message) => {
				if (connected()) host.onError?.(message)
			},
			onMessage: (message) => {
				if (connected()) host.onMessage?.(message)
			},
			invoke: (action) => {
				if (!connected()) return Promise.reject(new Error('App frame is detached'))
				return host.invoke(action)
			},
			dialog:
				host.dialog &&
				((request) => {
					if (!connected()) return Promise.reject(new Error('App frame is detached'))
					return host.dialog!(request)
				})
		})
		target.postMessage({ type: 'boot', guiCode, state }, '*', [port2])
	}
	frame.addEventListener('load', boot)
	container.append(frame)
	return {
		update(next: unknown) {
			if (disposed) return
			state = next
			bridge?.(state)
		},
		dispose() {
			if (disposed) return
			disposed = true
			frame.removeEventListener('load', boot)
			bridge?.dispose()
			frame.remove()
		}
	}
}

// Keep credentials and host handles out of GUI state: CSP does not block WebRTC.
const CSP = [
	"default-src 'none'",
	"script-src 'unsafe-inline' blob: https://esm.sh",
	"style-src 'unsafe-inline'",
	'img-src data: blob:',
	'font-src data: https://esm.sh',
	'media-src data: blob:',
	"connect-src 'none'",
	"form-action 'none'",
	"frame-src 'none'",
	"child-src 'none'",
	"object-src 'none'",
	"base-uri 'none'"
].join('; ')

const FRAME_SRCDOC = `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<style>${macCss}</style>
<style>html,body{margin:0;height:100%}#root{height:100%;overflow:hidden}</style>
<div id="root"></div>
<script>${guiFrameScript}</script>`
