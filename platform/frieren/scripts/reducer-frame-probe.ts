// Topology-B reducer-frame check. Validates that the REAL
// `sandboxWorkerSource(null, 'web')` output — the classic reducer Worker
// used in Topology B — actually loads and answers the host↔isolate protocol
// inside an opaque-origin `sandbox="allow-scripts"` iframe, under the frame CSP,
// on real browsers. This is the one thing the node vitest suite can't cover (it
// needs a real Worker + opaque origin + blob dynamic-import + Chromium's
// module-worker quirk); run it whenever you touch `sandboxWorkerSource` or the
// reducer frame in `platform/frieren/src/apps/sandbox.worker.ts`.
//
// Usage (from platform/frieren):
//   pnpm run verify:sandbox            # all engines
//   pnpm run verify:sandbox chromium   # one engine
//
// Requires the Playwright browsers: `npx playwright install chromium firefox webkit`.
// Exits non-zero if any engine that ran failed a check (missing browsers are
// reported as SKIP, not failure).

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { sandboxWorkerSource } from '@justfiles/app/sandbox'
import { type ConsoleMessage, chromium, firefox, webkit } from '@playwright/test'

const ENGINES = { chromium, firefox, webkit }
type EngineName = keyof typeof ENGINES

const USAGE = `Usage: pnpm run verify:sandbox [chromium|firefox|webkit|all]

Validates sandboxWorkerSource(null, 'web') (the Topology-B classic reducer
Worker) loads + answers the host↔isolate protocol inside an opaque-origin
sandboxed iframe under the frame CSP, on real browsers. Defaults to all engines.
Requires: npx playwright install chromium firefox webkit`

function parseEngines(): EngineName[] {
	const arg = process.argv[2]
	if (arg === '--help' || arg === '-h') {
		console.log(USAGE)
		process.exit(0)
	}
	if (!arg || arg === 'all') return Object.keys(ENGINES) as EngineName[]
	if (arg in ENGINES) return [arg as EngineName]
	console.error(`unknown engine "${arg}"\n\n${USAGE}`)
	process.exit(2)
}

const WORKER_SRC = sandboxWorkerSource(null, 'web')

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

type Frame = { id?: string; result?: { count?: number; state?: { count?: number } } }
type Check = { name: string; ok: boolean; detail: string }
type Result = {
	engine: EngineName
	status: 'pass' | 'fail' | 'skip'
	checks: Check[]
	note?: string
}

async function runEngine(engine: EngineName, baseUrl: string): Promise<Result> {
	let browser: Awaited<ReturnType<(typeof ENGINES)[EngineName]['launch']>>
	try {
		browser = await ENGINES[engine].launch()
	} catch (e) {
		// Almost always "browser not installed" — report as skip, not failure.
		return { engine, status: 'skip', checks: [], note: (e as Error).message.split('\n')[0] }
	}
	try {
		const page = await browser.newPage()
		const pageErrors: string[] = []
		page.on('console', (m: ConsoleMessage) => pageErrors.push(m.text()))
		page.on('pageerror', (e: Error) => pageErrors.push(`pageerror: ${e.message}`))
		await page.goto(baseUrl)
		// Wait until the dispatch reply lands, or the worker reports dead, or timeout.
		await page
			.waitForFunction(
				() => {
					const g = globalThis as unknown as { __frames: Frame[]; __log: string[] }
					return g.__frames.some((f) => f.id === '1') || g.__log.some((l) => l.startsWith('dead'))
				},
				{ timeout: 15_000 }
			)
			.catch(() => {})
		const { frames, log } = await page.evaluate(() => {
			const g = globalThis as unknown as { __frames: Frame[]; __log: string[] }
			return { frames: g.__frames ?? [], log: g.__log ?? [] }
		})

		const dead = log.find((l) => l.startsWith('dead'))
		const initial = frames.find((f) => f.id === '0')
		const dispatched = frames.find((f) => f.id === '1')
		const checks: Check[] = [
			{
				name: 'classic reducer worker loads + answers initialState',
				ok: !dead && initial?.result?.count === 7,
				detail: dead ?? JSON.stringify(initial ?? null)
			},
			{
				name: 'reducer dispatch round-trip (41→42)',
				ok: !dead && dispatched?.result?.state?.count === 42,
				detail: dead ?? JSON.stringify(dispatched ?? null)
			}
		]
		return { engine, status: checks.every((c) => c.ok) ? 'pass' : 'fail', checks }
	} finally {
		await browser.close()
	}
}

async function main() {
	const engines = parseEngines()
	const server = createServer((_req, res) => {
		res.setHeader('Content-Type', 'text/html')
		res.end(HOST_HTML)
	})
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
	const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

	const results: Result[] = []
	for (const engine of engines) results.push(await runEngine(engine, baseUrl))
	server.close()

	const icon = { pass: '✓', fail: '✗', skip: '–' } as const
	for (const r of results) {
		console.log(
			`\n${icon[r.status]} ${r.engine}: ${r.status.toUpperCase()}${r.note ? ` (${r.note})` : ''}`
		)
		for (const c of r.checks)
			console.log(`   ${c.ok ? '✓' : '✗'} ${c.name} ${c.ok ? '' : `— ${c.detail}`}`)
	}

	const failed = results.filter((r) => r.status === 'fail')
	const ran = results.filter((r) => r.status !== 'skip')
	console.log(
		`\n${failed.length === 0 && ran.length > 0 ? 'PASS' : 'FAIL'}: ${ran.length}/${results.length} engine(s) ran, ${failed.length} failed`
	)
	if (ran.length === 0)
		console.log('No engines ran — install them: npx playwright install chromium firefox webkit')
	process.exit(failed.length > 0 || ran.length === 0 ? 1 : 0)
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
