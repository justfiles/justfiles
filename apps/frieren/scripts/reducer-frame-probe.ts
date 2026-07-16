// Validates the REAL `sandboxWorkerSource(..., 'web-iframe')` output: a classic
// reducer Worker spawned inside an opaque-origin `sandbox="allow-scripts"` iframe
// (with the Step-5a CSP), loading the app bundle via `self.name` dynamic import,
// answering the actual host↔isolate protocol (`initialState`, then a `dispatch`).
//
// Run: node apps/frieren/scripts/reducer-frame-probe.ts [chromium|firefox|webkit]

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { sandboxWorkerSource } from '@justfiles/app/sandbox'
import { type ConsoleMessage, chromium, firefox, webkit } from '@playwright/test'

const engines = { chromium, firefox, webkit }
type Frame = { id?: string; result?: { count?: number; state?: { count?: number } } }

const engine = (process.argv[2] ?? 'chromium') as 'chromium' | 'firefox' | 'webkit'

const WORKER_SRC = sandboxWorkerSource('', 'web-iframe')

// A minimal self-contained reducer bundle (SDK already inlined by the compile).
const APP = `export const app = {
	initialState: { count: 7 },
	dispatch(action, ctx) { return { state: { count: ctx.state.count + 1 }, result: 'ok' } }
}`

// The frame mirrors sandbox.worker.ts's REDUCER_FRAME_SRCDOC (with CSP): on init
// it spawns one classic Worker whose name is the app blob URL, relays frames.
const FRAME_SRCDOC = `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; connect-src 'none'">
<script>
(function () {
	var worker
	window.addEventListener('message', function (e) {
		if (!e.data) return
		if (e.data.type === 'init' && !worker) {
			try {
				var appUrl = URL.createObjectURL(new Blob([e.data.code], { type: 'text/javascript' }))
				var wUrl = URL.createObjectURL(new Blob([e.data.src], { type: 'text/javascript' }))
				worker = new Worker(wUrl, { name: appUrl })
				worker.onerror = function (ev) { parent.postMessage({ dead: String((ev && ev.message) || 'worker error') }, '*') }
				worker.onmessage = function (ev) { parent.postMessage({ frame: ev.data }, '*') }
				parent.postMessage({ spawned: true }, '*')
			} catch (err) { parent.postMessage({ dead: String((err && err.message) || err) }, '*') }
		} else if (e.data.type === 'to-worker' && worker) worker.postMessage(e.data.m)
	})
	parent.postMessage({ ready: true }, '*')
})()
</script>`

const HOST_HTML = `<!doctype html><meta charset="utf-8"><title>host</title>
<iframe id="f" sandbox="allow-scripts"></iframe>
<script>
	const f = document.getElementById('f')
	f.srcdoc = ${JSON.stringify(FRAME_SRCDOC).replace(/<\/script>/g, '<\\/script>')}
	window.__log = []
	window.__frames = []
	window.addEventListener('message', (e) => {
		const d = e.data || {}
		if (d.ready) { window.__log.push('ready'); f.contentWindow.postMessage({ type: 'init', src: ${JSON.stringify(WORKER_SRC)}, code: ${JSON.stringify(APP)} }, '*') }
		else if (d.spawned) { window.__log.push('spawned'); f.contentWindow.postMessage({ type: 'to-worker', m: { type: 'initialState', id: '0' } }, '*') }
		else if (d.dead) { window.__log.push('dead:' + d.dead) }
		else if (d.frame) {
			window.__frames.push(d.frame)
			if (d.frame.id === '0') f.contentWindow.postMessage({ type: 'to-worker', m: { type: 'dispatch', id: '1', action: { type: 'inc' }, state: { count: 41 } } }, '*')
		}
	})
</script>`

async function main() {
	const server = createServer((_req, res) => {
		res.setHeader('Content-Type', 'text/html')
		res.end(HOST_HTML)
	})
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
	const port = (server.address() as AddressInfo).port

	const browser = await engines[engine].launch()
	const page = await browser.newPage()
	const logs: string[] = []
	page.on('console', (m: ConsoleMessage) => logs.push(m.text()))
	page.on('pageerror', (e: Error) => logs.push(`pageerror: ${e.message}`))
	await page.goto(`http://127.0.0.1:${port}`)
	await page.waitForTimeout(2500)
	const log = await page.evaluate(() => (globalThis as unknown as { __log: string[] }).__log)
	const frames = await page.evaluate(
		() => (globalThis as unknown as { __frames: Frame[] }).__frames
	)

	await browser.close()
	server.close()

	console.log(`\n=== reducer-frame probe: ${engine} ===`)
	console.log('log:', JSON.stringify(log))
	console.log('frames:', JSON.stringify(frames))
	if (logs.length) console.log('page logs:', logs)

	const initial = frames.find((f) => f.id === '0')
	const dispatched = frames.find((f) => f.id === '1')
	console.log('\n--- verdict ---')
	console.log(
		'classic reducer worker loaded + answered initialState:',
		initial && initial.result?.count === 7 ? 'YES' : 'NO',
		JSON.stringify(initial)
	)
	console.log(
		'reducer dispatch round-trip (41→42):',
		dispatched && dispatched.result?.state?.count === 42 ? 'YES' : 'NO',
		JSON.stringify(dispatched)
	)
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
