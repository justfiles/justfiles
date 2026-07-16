import type { GetSandbox, Sandbox } from '@justfiles/app'
import { sandboxClient, sandboxWorkerSource } from '@justfiles/app/sandbox'

// Browser-side `GetSandbox` (Topology B). The reducer runs the same volume-backed
// app.js bytes as the server kernel, but its Web Worker lives INSIDE a hidden
// opaque-origin `sandbox="allow-scripts"` iframe — the "reducer frame" — so it
// inherits that frame's null origin and can never `fetch` with the user's
// cookies. The host↔isolate protocol (`@justfiles/app/sandbox`) is unchanged; its
// frames just take one extra hop through the reducer frame's MessagePort. The
// kernel loads reducers for closed apps too (install/seed/reconcile warm
// `subscriptions(state)`), so ONE shared frame — decoupled from any GUI stage —
// hosts every app's reducer, keyed by content hash.

type WorkerClient = { sandbox: Sandbox; terminate: () => void }

// One reducer Worker per distinct app bundle (content hash), shared across every
// window of that app — mirroring the server's content-addressed isolate-per-app
// model. `appWorkers` maps an app id to its current bundle key so the host can
// `terminateAppWorker` when an app's last window closes (apps are 1:1 with their
// code, so an id resolves to exactly one worker).
const workers = new Map<string, Promise<WorkerClient>>()
const appWorkers = new Map<string, string>()

export function browserSandbox(): GetSandbox {
	return async ({ appId, code }) => {
		const key = await cacheKey(code)
		const worker = await workerFor(key, code)
		appWorkers.set(appId, key)
		return worker.sandbox
	}
}

function workerFor(key: string, code: string): Promise<WorkerClient> {
	let worker = workers.get(key)
	if (!worker) {
		worker = createWorker(key, code, () => workers.delete(key))
		workers.set(key, worker)
	}
	return worker
}

// Terminate the worker backing `appId` (called by the host when the app's last
// window closes) so its reducer Worker inside the frame is reclaimed.
export function terminateAppWorker(appId: string): void {
	const key = appWorkers.get(appId)
	if (!key) return
	appWorkers.delete(appId)
	const worker = workers.get(key)
	workers.delete(key)
	void worker?.then((client) => client.terminate()).catch(() => {})
}

// Drop the whole reducer realm — every reducer Worker and the frame itself.
// Called on OS teardown (sign-out / user switch), alongside `closeAll`, so a
// previous session's reducers don't leak into the next.
export function teardownReducerFrame(): void {
	for (const worker of workers.values())
		void worker.then((client) => client.terminate()).catch(() => {})
	workers.clear()
	appWorkers.clear()
	const current = frame
	frame = undefined
	void current?.then((f) => f.destroy()).catch(() => {})
}

async function cacheKey(code: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Spawn a reducer Worker inside the frame and wrap it as a `Sandbox`. `onDead`
// evicts this client from the worker cache so a crashed worker is never handed
// back out; the next dispatch rebuilds a fresh one.
async function createWorker(key: string, code: string, onDead: () => void): Promise<WorkerClient> {
	const f = await reducerFrame()
	const { sandbox, fail } = sandboxClient({
		post: (message) => f.post(key, message),
		onMessage: (handler) => f.bind(key, handler)
	})
	// A worker crash (its onerror inside the frame) rejects in-flight requests and
	// evicts the client, mirroring the host-Worker path this replaces.
	f.onDead(key, (message) => {
		onDead()
		fail(new Error(message))
	})
	f.spawn(key, code)
	return {
		sandbox,
		terminate: () => f.terminate(key)
	}
}

// ----- the shared reducer frame -----

// The reducer frame's control surface, seen by the host. It multiplexes every
// reducer Worker over one MessagePort, tagged by content-hash `key`.
type ReducerFrame = {
	spawn: (key: string, code: string) => void
	post: (key: string, message: unknown) => void
	terminate: (key: string) => void
	bind: (key: string, onMessage: (message: unknown) => void) => void
	onDead: (key: string, handler: (message: string) => void) => void
	destroy: () => void
}

// The reducer Worker source is constant: the app bundle's blob URL is passed to
// the frame per-spawn and handed to the Worker as its `name` (read as self.name),
// so this string never varies. See `sandboxWorkerSource(..., 'web-iframe')`.
const WORKER_SRC = sandboxWorkerSource('', 'web-iframe')

// The hidden iframe's document. CSP makes it network-deny-by-default: only
// inline (its own bootstrap) and blob: scripts run, only blob: workers spawn, and
// `connect-src 'none'` blocks fetch/XHR/WebSocket/beacon — so a reducer holding
// chroot files or capability results can't exfiltrate them. Blob workers inherit
// this document's CSP, so the restriction covers the reducer Worker too. On
// `init` it stores the shared port + worker source; then it spawns, feeds, and
// terminates content-hashed Workers on the host's command, relaying each Worker
// frame back tagged with its key.
const REDUCER_FRAME_SRCDOC = `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; connect-src 'none'">
<script>
(function () {
	var port, workerSrc
	var workers = new Map()
	function spawn(key, code) {
		if (workers.has(key)) return
		try {
			var appUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
			var workerUrl = URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' }))
			var w = new Worker(workerUrl, { name: appUrl })
			w.onmessage = function (ev) { port.postMessage({ t: 'msg', key: key, m: ev.data }) }
			w.onerror = function (ev) {
				port.postMessage({ t: 'dead', key: key, error: String((ev && ev.message) || 'reducer worker error') })
				try { w.terminate() } catch (e) {}
				workers.delete(key)
			}
			workers.set(key, w)
		} catch (err) {
			port.postMessage({ t: 'dead', key: key, error: String((err && err.message) || err) })
		}
	}
	window.addEventListener('message', function (e) {
		if (!e.data || e.data.type !== 'init' || port) return
		port = e.ports[0]
		workerSrc = e.data.src
		port.onmessage = function (ev) {
			var m = ev.data
			if (m.t === 'spawn') spawn(m.key, m.code)
			else if (m.t === 'msg') { var w = workers.get(m.key); if (w) w.postMessage(m.m) }
			else if (m.t === 'terminate') {
				var t = workers.get(m.key)
				if (t) { try { t.terminate() } catch (e) {} workers.delete(m.key) }
			}
		}
	})
	parent.postMessage({ type: 'reducer-ready' }, '*')
})()
</script>`

let frame: Promise<ReducerFrame> | undefined

function reducerFrame(): Promise<ReducerFrame> {
	frame ??= createReducerFrame()
	return frame
}

// Stand up the hidden reducer frame: append it, wait for its `reducer-ready`
// handshake, hand it one port + the worker source, and keep the other port for
// the demux below.
function createReducerFrame(): Promise<ReducerFrame> {
	return new Promise((resolve, reject) => {
		const iframe = document.createElement('iframe')
		iframe.setAttribute('sandbox', 'allow-scripts')
		iframe.style.display = 'none'
		iframe.setAttribute('aria-hidden', 'true')
		iframe.srcdoc = REDUCER_FRAME_SRCDOC

		// Per-key relays for worker frames coming back from the iframe.
		const onMessages = new Map<string, (message: unknown) => void>()
		const onDeads = new Map<string, (message: string) => void>()

		const cleanup = () => window.removeEventListener('message', onReady)
		const timer = setTimeout(() => {
			cleanup()
			iframe.remove()
			reject(new Error('reducer frame failed to initialise'))
		}, 10_000)

		function onReady(e: MessageEvent): void {
			if (
				e.source !== iframe.contentWindow ||
				(e.data as { type?: string })?.type !== 'reducer-ready'
			)
				return
			cleanup()
			clearTimeout(timer)
			const { port1, port2 } = new MessageChannel()
			port1.onmessage = (ev) => {
				const d = ev.data as { t: string; key: string; m?: unknown; error?: string }
				if (d.t === 'msg') onMessages.get(d.key)?.(d.m)
				else if (d.t === 'dead') {
					onDeads.get(d.key)?.(d.error ?? 'reducer worker error')
					onMessages.delete(d.key)
					onDeads.delete(d.key)
				}
			}
			iframe.contentWindow?.postMessage({ type: 'init', src: WORKER_SRC }, '*', [port2])
			resolve({
				spawn: (key, code) => port1.postMessage({ t: 'spawn', key, code }),
				post: (key, message) => port1.postMessage({ t: 'msg', key, m: message }),
				terminate: (key) => {
					onMessages.delete(key)
					onDeads.delete(key)
					port1.postMessage({ t: 'terminate', key })
				},
				bind: (key, onMessage) => onMessages.set(key, onMessage),
				onDead: (key, handler) => onDeads.set(key, handler),
				destroy: () => {
					port1.close()
					iframe.remove()
				}
			})
		}
		window.addEventListener('message', onReady)
		document.body.appendChild(iframe)
	})
}
