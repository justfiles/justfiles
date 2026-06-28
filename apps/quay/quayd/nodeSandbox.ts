// `GetSandbox` over `node:worker_threads`, with idle eviction (Slice 8). The
// host↔isolate protocol lives in `@justfiles/app/sandbox` (shared with frieren's
// Web-Worker sandbox); this is the Node transport plus the
// lifecycle policy:
//
//   • Lazy + content-addressed — one worker per distinct app bundle (keyed by code
//     SHA), spawned on first dispatch/launch, reused across re-opens of the same
//     bytes. New bytes (a reinstall/update) spawn a fresh worker. (Slice 7.)
//   • Idle eviction — a worker is pinned while its app has an open window; when the
//     last window closes it lives `idleMs` longer, then is terminated. The kernel
//     persists state to disk (`/state/<id>.json`), so the next dispatch transparently
//     re-spawns it. Reducer code runs here — off quayd's main thread, never in a
//     webview.
//
// `retain`/`release` track the berth (window) lifecycle, driven from `server.ts`.

import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import type { GetSandbox, Sandbox } from '@justfiles/app/runtime'
import { sandboxClient } from '@justfiles/app/sandbox'
// How a self-contained app bundle becomes a Worker — the one runtime divergence: a data:
// URL on node, a blob: URL on bun (Bun's loader throws ENAMETOOLONG on a large data: URL).
// Resolved by the runtime via package.json `imports`. See `quayd/sandboxUrl.{node,bun}.ts`.
import { sandboxWorker } from '#sandbox-url'

export interface NodeSandbox {
	// The kernel's `GetSandbox`: load-or-reuse the worker for these bytes.
	get: GetSandbox
	// A window opened/closed for `appId` — pins/unpins its worker against eviction.
	retain(appId: string): void
	release(appId: string): void
	// Live worker count (for the eviction verify/tests).
	resident(): number
}

interface Cell {
	sandbox: Sandbox
	worker: Worker
	// The app this worker last served — its open-window count gates eviction.
	// Content-addressing means two byte-identical apps would share a cell (the most
	// recent owner wins); distinct apps have distinct code, so in practice it's 1:1.
	appId: string
	timer?: ReturnType<typeof setTimeout>
	// True once we intentionally tore the worker down — so its `exit` isn't a crash.
	evicted: boolean
}

// Default idle grace after the last window closes. Shorter than the http idle-exit
// (server.ts), so a closed app's worker is reclaimed before the daemon itself.
const IDLE_MS = 3 * 60_000

export function nodeSandbox(opts: { idleMs?: number } = {}): NodeSandbox {
	const idleMs = opts.idleMs ?? IDLE_MS
	const cells = new Map<string, Cell>() // code SHA → worker
	const windows = new Map<string, number>() // appId → open-window count

	const open = (appId: string): number => windows.get(appId) ?? 0

	const evict = (key: string): void => {
		const cell = cells.get(key)
		if (!cell) return
		cells.delete(key)
		cell.evicted = true
		void cell.worker.terminate()
	}

	// Arm an idle timer when `cell`'s app has no open window; clear it otherwise.
	const rearm = (key: string, cell: Cell): void => {
		if (cell.timer) {
			clearTimeout(cell.timer)
			cell.timer = undefined
		}
		if (open(cell.appId) === 0) cell.timer = setTimeout(() => evict(key), idleMs)
	}

	const rearmApp = (appId: string): void => {
		for (const [key, cell] of cells) if (cell.appId === appId) rearm(key, cell)
	}

	return {
		get: async ({ appId, code }) => {
			// The cache key is over the self-contained bundle `code` — deterministic, so a
			// byte-identical app reuses its worker (a resolved blob: URL must NOT enter it).
			const key = createHash('sha256').update(code).digest('hex')
			let cell = cells.get(key)
			if (!cell) {
				cell = spawn(code, () => cells.delete(key))
				cells.set(key, cell)
			}
			cell.appId = appId
			rearm(key, cell)
			return cell.sandbox
		},
		retain: (appId) => {
			windows.set(appId, open(appId) + 1)
			rearmApp(appId) // a reopened window before eviction re-pins its live worker
		},
		release: (appId) => {
			const next = open(appId) - 1
			if (next > 0) windows.set(appId, next)
			else {
				windows.delete(appId)
				rearmApp(appId) // last window gone → start the idle countdown
			}
		},
		resident: () => cells.size
	}

	function spawn(code: string, onDead: () => void): Cell {
		const { url, options } = sandboxWorker(code)
		const worker = new Worker(url, options)
		const { sandbox, fail } = sandboxClient({
			post: (message) => worker.postMessage(message),
			onMessage: (handler) => worker.on('message', handler)
		})
		const cell: Cell = { sandbox, worker, appId: '', evicted: false }
		const die = (error: Error): void => {
			if (cell.evicted) return // an intentional idle teardown, not a crash
			onDead()
			fail(error)
		}
		worker.on('error', die)
		worker.on('exit', (exitCode) => {
			if (exitCode !== 0) die(new Error(`sandbox worker exited: ${exitCode}`))
		})
		return cell
	}
}
