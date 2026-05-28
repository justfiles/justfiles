import type { Effect } from '@justfiles/state'
import type { Volume } from '../fs'
import type * as kernelAppHostModule from '../kernelAppHost'
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
	kernelAppHost: Pick<typeof kernelAppHostModule, 'open' | 'close'>
	getToken: () => Promise<string | null>
	guiUrlFor: (appId: string) => string | undefined
	send: (frame: object) => void
}

// Mirror window open/close into the imperative kernel-app host and tell the
// server, which tracks each user's running apps.
export function makeKernelHostEffect(env: KernelHostEnv): Effect<OsState, OsAction> {
	return (action) => {
		if (action.type === 'app.open') {
			env.kernelAppHost.open(action.appId, {
				guiUrl: env.guiUrlFor(action.appId),
				getToken: env.getToken
			})
			env.send({ type: 'kernel_app_open', id: action.appId })
		} else if (action.type === 'window.close') {
			env.kernelAppHost.close(action.id)
			env.send({ type: 'kernel_app_close', id: action.id })
		}
	}
}

export interface PersistEnv {
	volume: Volume
	// Exact bytes already on disk, so the boot round-trip is suppressed.
	initialSerialized?: string | null
}

export function makePersistEffect(env: PersistEnv): Effect<OsState, OsAction> {
	let lastWritten = env.initialSerialized ?? null
	const writeNow = debounce(
		(state: OsState) => {
			const serialized = JSON.stringify(state)
			if (serialized === lastWritten) return
			lastWritten = serialized
			void saveSnapshot(env.volume, serialized).catch((error) => {
				console.error('os-state persist failed', error)
			})
		},
		300,
		2000
	)
	return (_action, _previous, next) => {
		if (!next.booted) return
		writeNow(next)
	}
}
