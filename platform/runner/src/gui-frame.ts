import { guiFrameScript } from '@justfiles/app/iframe'

// This CSP blocks normal request paths. It is not total egress isolation because
// `connect-src` does not control WebRTC. Never send credentials or host handles
// to the GUI, and treat all state and capability results as publisher-visible.
export const guestCsp = (release: string) =>
	[
		"default-src 'none'",
		`script-src 'unsafe-inline' 'wasm-unsafe-eval' blob: ${release} https://esm.sh`,
		"style-src 'unsafe-inline'",
		`img-src data: blob: ${release}`,
		`font-src data: ${release}`,
		`media-src data: blob: ${release}`,
		`connect-src ${release}`,
		"form-action 'none'",
		"frame-src 'none'",
		"child-src 'none'",
		"object-src 'none'",
		"base-uri 'none'",
		"navigate-to 'none'",
		"frame-ancestors 'self'"
	].join('; ')

const shelfScript = `(function () {
	var booted = false
	window.addEventListener('message', function (event) {
		if (event.source !== parent || !event.data || event.data.type !== 'boot' || booted) return
		var port = event.ports[0]
		if (!port) return
		booted = true
		var scrollTops = new WeakMap()
		window.addEventListener('scroll', function (scrollEvent) {
			if (!(scrollEvent.target instanceof Element)) return
			var top = scrollEvent.target.scrollTop
			var last = scrollTops.get(scrollEvent.target) || 0
			if (top > last + 4 && top > 24) port.postMessage({ type: 'shelf', hidden: true })
			else if (top < last - 4) port.postMessage({ type: 'shelf', hidden: false })
			scrollTops.set(scrollEvent.target, top)
		}, true)
		window.addEventListener('pointermove', function (pointerEvent) {
			if (pointerEvent.clientY < 46) port.postMessage({ type: 'shelf', hidden: false })
		})
	})
})()`

export function frameDocument(css: string): string {
	return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style>
<style>html,body{margin:0;height:100%}#root{height:100%;overflow:hidden}</style>
</head><body><div id="root"></div>
<script>${shelfScript}</script>
<script>${guiFrameScript}</script>
</body></html>`
}
