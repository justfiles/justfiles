import type { GetSandbox, Sandbox } from '@justfiles/app/runtime'
import { sandboxClient, sandboxWorkerSource } from '@justfiles/app/sandbox'

type Cell = {
	code: string
	sandbox: Sandbox
	stop: (error?: Error) => void
	// Idle-eviction timer, armed only while the app has no open window.
	timer?: ReturnType<typeof setTimeout>
}

export interface SandboxPool {
	// The kernel's `GetSandbox`: load-or-reuse the worker for these bytes.
	get: GetSandbox
	// A window opened/closed for `appId` — pins/unpins its worker against idle eviction.
	retain(appId: string): void
	release(appId: string): void
	// Live worker count (for eviction tests).
	resident(): number
}

// Idle grace after an app's last window closes before its reducer worker is reaped.
// The kernel persists state to disk, so the next dispatch transparently re-spawns it.
const IDLE_MS = 3 * 60_000

export function sandboxPool({ idleMs = IDLE_MS }: { idleMs?: number } = {}): SandboxPool {
	const cells = new Map<string, Cell>() // appId → reducer worker
	const windows = new Map<string, number>() // appId → open-window count

	const open = (appId: string): number => windows.get(appId) ?? 0

	const evict = (appId: string, cell: Cell): void => {
		// Guard against a stale timer firing after the cell was replaced or already gone.
		if (cells.get(appId) !== cell) return
		cells.delete(appId)
		cell.stop(new Error('sandbox worker evicted (idle)'))
	}

	// (Re)arm the idle timer: cleared while a window is open or on activity, restarted
	// once the app has no open window so an idle worker is reaped after `idleMs`.
	const rearm = (appId: string): void => {
		const cell = cells.get(appId)
		if (!cell) return
		if (cell.timer) clearTimeout(cell.timer)
		cell.timer = open(appId) === 0 ? setTimeout(() => evict(appId, cell), idleMs) : undefined
	}

	return {
		get: async ({ appId, code }) => {
			let cell = cells.get(appId)
			if (cell?.code !== code) {
				cell?.stop(new Error('sandbox worker replaced'))
				cell = spawn(code, () => {
					if (cells.get(appId) === cell) cells.delete(appId)
				})
				cells.set(appId, cell)
			}
			rearm(appId) // a dispatch counts as activity → push the idle countdown out
			return cell.sandbox
		},
		retain: (appId) => {
			windows.set(appId, open(appId) + 1)
			rearm(appId) // a window reopened before eviction re-pins the live worker
		},
		release: (appId) => {
			const next = open(appId) - 1
			if (next > 0) windows.set(appId, next)
			else {
				windows.delete(appId)
				rearm(appId) // last window gone → start the idle countdown
			}
		},
		resident: () => cells.size
	}
}

// The shared pool the kernel loads sandboxes from and the server pins windows against.
export const sandboxes = sandboxPool()

function spawn(code: string, onDead: () => void): Cell {
	const appUrl = blobUrl(code)
	const workerUrl = blobUrl(sandboxWorkerSource(appUrl, 'web'))
	const worker = new Worker(workerUrl, { smol: true, ref: false })
	const { sandbox, fail } = sandboxClient({
		post: (message) => worker.postMessage(message),
		onMessage: (handler) => worker.addEventListener('message', (event) => handler(event.data))
	})
	let stopped = false
	const stop = (error?: Error): void => {
		if (stopped) return
		stopped = true
		if (error) fail(error)
		worker.terminate()
		URL.revokeObjectURL(workerUrl)
		URL.revokeObjectURL(appUrl)
	}
	const die = (error: Error): void => {
		if (stopped) return
		onDead()
		stop(error)
	}
	worker.addEventListener('error', (event) => die(event.error ?? new Error(event.message)))
	worker.addEventListener('close', (event) =>
		die(new Error(`sandbox worker closed: ${event.code}`))
	)
	return { code, sandbox, stop }
}

function blobUrl(source: string): string {
	return URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
}
