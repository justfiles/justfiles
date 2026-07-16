// Risk gate for IFRAME_ISOLATION_PLAN.md Step 4 (Topology B): probe several
// worker-spawn variants inside a `sandbox="allow-scripts"` (opaque origin,
// no allow-same-origin) iframe to find which spawns work, and confirm the
// network is deny-by-default from inside the reducer worker.
//
// Run: node apps/frieren/scripts/risk-gate-probe.ts [chromium|firefox|webkit] [--csp]

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type ConsoleMessage, chromium, firefox, webkit } from '@playwright/test'

const engines = { chromium, firefox, webkit }
type Probe = {
	label?: string
	ok?: boolean
	origin?: string
	phase?: string
	msg?: { app?: string; net?: { ok: boolean; status?: number; error?: string } }
	detail?: unknown
}

const engine = (process.argv[2] ?? 'chromium') as 'chromium' | 'firefox' | 'webkit'
const withCsp = process.argv.includes('--csp')

// A CSP that only permits blob: scripts/workers and no network (mirrors Step 5a).
const CSP = `default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; connect-src 'none'`
const cspMeta = withCsp ? `<meta http-equiv="Content-Security-Policy" content="${CSP}">` : ''
const HOST_PLACEHOLDER = '__HOST_ORIGIN__'

const FRAME_SRCDOC = `<!doctype html><meta charset="utf-8">${cspMeta}<title>frame</title>
<script>
(function () {
	function report(r) { parent.postMessage({ probe: r }, '*') }
	function detail(ev) { return { message: ev && ev.message, filename: ev && ev.filename, lineno: ev && ev.lineno } }
	function spawn(label, src, type) {
		try {
			var url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))
			var w = new Worker(url, type === 'module' ? { type: 'module' } : undefined)
			w.onerror = function (ev) { report({ label: label, ok: false, phase: 'onerror', detail: detail(ev) }); try { w.terminate() } catch (e) {} }
			w.onmessage = function (ev) { report({ label: label, ok: true, msg: ev.data }); try { w.terminate() } catch (e) {} }
		} catch (err) {
			report({ label: label, ok: false, phase: 'threw', name: String(err && err.name), message: String(err && err.message) })
		}
	}
	report({ label: 'frame', ok: true, origin: location.origin })
	var appUrl = URL.createObjectURL(new Blob(['export const app = { name: "reducer-analog" }'], { type: 'text/javascript' }))
	// 1) classic worker, self-contained
	spawn('classic', 'self.postMessage("classic-ok")', 'classic')
	// 2) module worker, self-contained (no imports)
	spawn('module-noimport', 'self.postMessage("module-noimport-ok")', 'module')
	// 3) module worker importing a second blob module (the naive reducer shape)
	spawn('module-import', 'import { app } from ' + JSON.stringify(appUrl) + '; self.postMessage("module-import-ok:" + app.name)', 'module')
	// 4) classic worker + dynamic import() of the app blob (the Topology-B path),
	//    then probe the network: a credentialed fetch to the host origin.
	var host = ${JSON.stringify(HOST_PLACEHOLDER)}
	var netSrc = 'import(' + JSON.stringify(appUrl) + ').then(async (m) => {'
		+ ' let net; try { const r = await fetch(' + JSON.stringify(host) + ' + "/secret", { credentials: "include" }); net = { ok: true, status: r.status } }'
		+ ' catch (e) { net = { ok: false, error: String(e && e.message || e) } }'
		+ ' self.postMessage({ app: m.app.name, net }) }).catch(e => self.postMessage({ err: String(e && e.message) }))'
	spawn('classic-dynimport', netSrc, 'classic')
})()
</script>`

const HOST_HTML = `<!doctype html><meta charset="utf-8"><title>host</title>
<iframe id="f" sandbox="allow-scripts"></iframe>
<script>
	const f = document.getElementById('f')
	f.srcdoc = ${JSON.stringify(FRAME_SRCDOC).replace(/<\/script>/g, '<\\/script>')}.replaceAll(${JSON.stringify(HOST_PLACEHOLDER)}, location.origin)
	window.__probe = []
	window.addEventListener('message', (e) => { if (e.data && e.data.probe) window.__probe.push(e.data.probe) })
</script>`

async function main() {
	const server = createServer((req, res) => {
		if (req.url === '/') {
			res.setHeader('Content-Type', 'text/html')
			res.end(HOST_HTML)
			return
		}
		if (req.url === '/secret') {
			res.setHeader('Set-Cookie', 'probe=1; SameSite=Lax')
			res.end('secret-bytes') // no Access-Control-Allow-Origin → cross-origin opaque fetch blocked
			return
		}
		res.statusCode = 404
		res.end('nope')
	})
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
	const port = (server.address() as AddressInfo).port
	const base = `http://127.0.0.1:${port}`

	const browser = await engines[engine].launch()
	const page = await browser.newPage()
	const logs: string[] = []
	page.on('console', (m: ConsoleMessage) => logs.push(m.text()))
	page.on('pageerror', (e: Error) => logs.push(`pageerror: ${e.message}`))
	await page.goto(base)
	await page.waitForTimeout(2500)
	const arr = await page.evaluate(() => (globalThis as unknown as { __probe: Probe[] }).__probe)

	console.log(`\n=== risk gate: ${engine}${withCsp ? ' (+CSP)' : ''} ===`)
	console.log(JSON.stringify(arr, null, 2))
	if (logs.length) console.log('page logs:', logs)

	await browser.close()
	server.close()

	const frame = arr.find((r) => r.label === 'frame')
	console.log('\n--- verdict ---')
	console.log('frame origin:', frame?.origin, '(expect "null")')
	for (const label of ['classic', 'module-noimport', 'module-import', 'classic-dynimport']) {
		const r = arr.find((x) => x.label === label)
		console.log(
			`  ${label}:`,
			r
				? r.ok
					? `OK (${JSON.stringify(r.msg)})`
					: `FAIL ${JSON.stringify(r.detail ?? r)}`
				: 'no result'
		)
	}
	const net = arr.find((x) => x.label === 'classic-dynimport')?.msg?.net
	if (net)
		console.log(
			'  network (credentialed host fetch):',
			net.ok ? 'REACHABLE (LEAK!)' : 'BLOCKED',
			JSON.stringify(net)
		)
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
