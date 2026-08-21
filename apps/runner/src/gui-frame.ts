import { guiFrameScript } from '@justfiles/app/iframe'

export const GUEST_CSP = [
	"default-src 'none'",
	"script-src 'unsafe-inline' blob:",
	"style-src 'unsafe-inline'",
	'img-src data: blob:',
	'font-src data:',
	'media-src data: blob:',
	"connect-src 'none'",
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
