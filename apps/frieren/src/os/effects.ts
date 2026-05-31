import type { Kernel } from '@justfiles/app'
import type { Effect } from '@justfiles/state'
import type * as appHostModule from '../apps/host'
import type { Volume } from '../fs'
import { saveSnapshot } from './persistence'
import type { OsAction, OsState } from './state'

// Coalesce a burst of streaming geometry writes; every other durable change
// writes promptly, so this only ever delays rect updates.
const GEOMETRY_DEBOUNCE_MS = 300

export interface KernelHostEnv {
	appHost: Pick<typeof appHostModule, 'open' | 'close'>
	getToken: () => Promise<string | null>
	send: (frame: object) => void
	localKernel: () => Promise<Kernel>
	volume: Promise<Volume>
}

// Mirror window open/close into the imperative app host. User gestures also
// tell the server; server-echoed actions (`remote`) only sync the host.
export function makeKernelHostEffect(env: KernelHostEnv): Effect<OsState, OsAction> {
	const openOptions = {
		getToken: env.getToken,
		localKernel: env.localKernel,
		volume: env.volume
	}
	return (action, _previous, next) => {
		if (action.type === 'boot/loaded') {
			// Restore the GUI for every persisted window by opening its host stage
			// directly. This is client-driven restoration, so it must not echo
			// `app_open` back to the server. The GUI loads from the local volume,
			// so restoration need not wait on the catalog.
			for (const id of next.openOrder) {
				const window = next.windows[id]
				if (!window) continue
				env.appHost.open(window.id, openOptions)
			}
			return
		}
		if (action.type === 'app.open') {
			env.appHost.open(action.appId, openOptions)
			if (!action.remote) env.send({ type: 'app_open', id: action.appId })
		} else if (action.type === 'window.close') {
			env.appHost.close(action.id)
			if (!action.remote) env.send({ type: 'app_close', id: action.id })
		}
	}
}

export interface PersistEnv {
	// A promise so the store can be created before the volume resolves.
	volume: Promise<Volume>
}

export interface PersistController {
	effect: Effect<OsState, OsAction>
	// Force any pending debounced write out now (page hide / unmount).
	flush(): void
}

export function makePersistEffect(env: PersistEnv): PersistController {
	let lastWritten: string | null = null
	let pending: OsState | null = null
	let timer: ReturnType<typeof setTimeout> | null = null

	const clearTimer = () => {
		if (timer !== null) {
			clearTimeout(timer)
			timer = null
		}
	}

	const write = (state: OsState) => {
		const serialized = JSON.stringify(state)
		if (serialized === lastWritten) return
		lastWritten = serialized
		void env.volume
			.then((vol) => saveSnapshot(vol, serialized))
			.catch((error) => {
				console.error('os-state persist failed', error)
			})
	}

	const flush = () => {
		clearTimer()
		const state = pending
		pending = null
		if (state) write(state)
	}

	const effect: Effect<OsState, OsAction> = (action, _previous, next) => {
		// The boot snapshot is already on disk — record it as written so the
		// hydration dispatch doesn't round-trip the bytes we just read.
		if (action.type === 'boot/loaded') {
			lastWritten = JSON.stringify(next)
			return
		}
		if (!next.booted) return
		// Geometry can stream during a drag/resize, so coalesce it. Every other
		// durable change (open/close, mode, focus/order, agent surface) writes
		// promptly, so a refresh right after the gesture keeps the committed state.
		if (action.type === 'window.rectUpdated') {
			pending = next
			clearTimer()
			timer = setTimeout(flush, GEOMETRY_DEBOUNCE_MS)
			return
		}
		// A prompt write supersedes any pending geometry write (same cumulative
		// state), so drop the timer and persist now.
		clearTimer()
		pending = null
		write(next)
	}

	return { effect, flush }
}
