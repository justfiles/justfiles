import type { Effect } from '@justfiles/state'
import type * as appHostModule from '../apps/host'
import type { Volume } from '../fs'
import { saveSnapshot } from './persistence'
import type { OsAction, OsState } from './state'

// Trailing-edge debounce that also fires once `maxWait` has elapsed since the
// first call in a burst, bounding how long a pending write can be deferred.
function debounce<A extends unknown[]>(
	fn: (...args: A) => void,
	wait: number,
	maxWait: number
): (...args: A) => void {
	let timer: ReturnType<typeof setTimeout> | null = null
	let firstAt = 0
	let pending: A | null = null

	const flush = () => {
		timer = null
		firstAt = 0
		const args = pending
		pending = null
		if (args) fn(...args)
	}

	return (...args: A) => {
		pending = args
		const now = Date.now()
		if (firstAt === 0) firstAt = now
		const delay = Math.min(wait, Math.max(0, maxWait - (now - firstAt)))
		if (timer !== null) clearTimeout(timer)
		timer = setTimeout(flush, delay)
	}
}

export interface KernelHostEnv {
	appHost: Pick<typeof appHostModule, 'open' | 'close'>
	getToken: () => Promise<string | null>
	guiUrlFor: (appId: string) => string | undefined
	send: (frame: object) => void
}

// Mirror window open/close into the imperative app host. User gestures also
// tell the server; server-echoed actions (`remote`) only sync the host.
export function makeKernelHostEffect(env: KernelHostEnv): Effect<OsState, OsAction> {
	return (action) => {
		if (action.type === 'app.open') {
			env.appHost.open(action.appId, {
				guiUrl: env.guiUrlFor(action.appId),
				getToken: env.getToken
			})
			// Legacy wire naming: app open/close protocol frames still use kernel_app_*.
			if (!action.remote) env.send({ type: 'kernel_app_open', id: action.appId })
		} else if (action.type === 'window.close') {
			env.appHost.close(action.id)
			if (!action.remote) env.send({ type: 'kernel_app_close', id: action.id })
		}
	}
}

export interface PersistEnv {
	// A promise so the store can be created before the volume resolves.
	volume: Promise<Volume>
}

export function makePersistEffect(env: PersistEnv): Effect<OsState, OsAction> {
	let lastWritten: string | null = null
	const writeNow = debounce(
		(state: OsState) => {
			const serialized = JSON.stringify(state)
			if (serialized === lastWritten) return
			lastWritten = serialized
			void env.volume
				.then((vol) => saveSnapshot(vol, serialized))
				.catch((error) => {
					console.error('os-state persist failed', error)
				})
		},
		300,
		2000
	)
	return (action, _previous, next) => {
		// The boot snapshot is already on disk — record it as written so the
		// hydration dispatch doesn't round-trip the bytes we just read.
		if (action.type === 'boot/loaded') {
			lastWritten = JSON.stringify(next)
			return
		}
		if (!next.booted) return
		writeNow(next)
	}
}
