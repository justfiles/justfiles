import type { Message, Subscription } from './app.ts'
import type { Capabilities } from './capabilities/types.ts'
import type { Declared } from './kernel.capability.ts'
import { SUB_EVENT_PREFIX } from './sdk.ts'

type AppId = string

// One running stream's teardown. `stop` is idempotent-safe: it flags the slot
// stopped and calls the host unsubscribe once it has resolved.
type RunningSub = { stop: () => void }

interface SubscriptionDeps {
	// Resolve a LOCAL capability name to its trusted { id, scopes } (the trust
	// boundary; see kernel.capability.ts).
	resolve: (appId: AppId, name: string) => Promise<Declared | undefined>
	// The capability seam's subscribe arm. The runtime calls it with the RESOLVED
	// trusted id + scopes; `emit` feeds each event back into the reducer. Absent →
	// subscriptions are inert (reconcile/ensure no-op); an app that declares none
	// still dispatches normally.
	subscribe?: Capabilities['subscribe']
	// Re-enter a stream event into the reducer (the kernel's dispatch). Injecting
	// it keeps the runtime → kernel direction one-way (no import cycle).
	dispatch: (appId: AppId, message: Message) => Promise<unknown>
	// The per-app queue, so a warm-from-boot reconcile serializes with dispatch.
	enqueue: <T>(appId: AppId, task: () => Promise<T>) => Promise<T>
	// The streams an app's PERSISTED state declares, or null if it is not installed.
	// Used by `ensure` to rebuild the set from boot.
	loadDesired: (appId: AppId) => Promise<Subscription[] | null>
	// Surface a non-fatal failure (a stream that could not open or route).
	onError: (appId: AppId, error: string) => void
}

export interface Subscriptions {
	// Converge the running set to the desired one (computed by the bundle). Called
	// after every commit; a pure synchronous diff (host starts are fire-and-forget).
	reconcile(appId: AppId, desired: Subscription[]): void
	// Lazily warm an app's streams from persisted state on first touch. No-op once
	// warm or when no host stream opener is wired.
	ensure(appId: AppId): void
	// Stop all of an app's streams (uninstall / pre-reinstall).
	stop(appId: AppId): void
	// Stop every stream and prevent an in-flight warm-up from re-arming one.
	dispose(): void
}

// The subscription reconciler (Part D). `subscriptions(state)` (in the bundle)
// declares the ongoing streams the current state wants. After every commit the
// kernel diffs that declared set against the running one — keyed structurally by
// the whole descriptor (see `subKey`) — starting new streams and stopping gone ones.
// Each emitted event re-enters the reducer as a `__sub/<to>` message. Recoverable
// by construction: the set is a pure function of persisted state, rebuilt on boot.
export function subscriptionRuntime({
	resolve,
	subscribe,
	dispatch,
	enqueue,
	loadDesired,
	onError
}: SubscriptionDeps): Subscriptions {
	// Per-app running streams, keyed by the structural subscription key. In-memory
	// only — rebuilt from persisted state on boot (the set is a pure function of
	// state), so a DO hibernate/restart loses the host watchers and the next touch
	// re-warms them.
	const subs = new Map<AppId, Map<string, RunningSub>>()
	let disposed = false

	return { reconcile, ensure, stop, dispose }

	// The structural identity of a DECLARED stream. Every field of the descriptor is in
	// it, `coalesce` included: `startStream` captures the descriptor it was started with,
	// so a key that ignored the mode would read a mode flip as "unchanged" and keep
	// running the old one — leaving an unbounded stream unbounded, or dropping events
	// after coalescing was declared off. Same key must mean same declaration, or the
	// reconciler cannot claim to converge. (kernel.command.ts's `coalesceKey` omits the
	// flag for the opposite reason: it identifies work ALREADY known to be coalescing —
	// a plain command never reaches that map.)
	function subKey(sub: Subscription): string {
		return JSON.stringify([sub.capability, sub.method, sub.args, sub.to, sub.coalesce ?? false])
	}

	function reconcile(appId: AppId, desired: Subscription[]): void {
		if (!subscribe || disposed) return
		const want = new Map<string, Subscription>()
		for (const sub of desired) want.set(subKey(sub), sub)
		let running = subs.get(appId)
		if (!running) {
			running = new Map()
			subs.set(appId, running)
		}
		for (const [key, entry] of running) {
			if (!want.has(key)) {
				entry.stop()
				running.delete(key)
			}
		}
		for (const [key, sub] of want) if (!running.has(key)) startSub(appId, running, key, sub)
	}

	// Start one stream. The host start is async (it resolves the unsubscribe), so a
	// placeholder claims the slot synchronously; if a concurrent diff stops it
	// before the start resolves, the resolved unsubscribe is called at once.
	function startSub(
		appId: AppId,
		running: Map<string, RunningSub>,
		key: string,
		sub: Subscription
	): void {
		let stopped = false
		let unsub: (() => void) | null = null
		const entry: RunningSub = {
			stop: () => {
				stopped = true
				unsub?.()
			}
		}
		running.set(key, entry)
		// A stream is live only while it is THIS entry and unstopped. The host
		// unsubscribe is not guaranteed synchronous (volume.watch coalesces onto a
		// microtask), so a stopped/switched stream can still fire a late event —
		// drop it rather than reduce stale data into the current state.
		const isLive = () => !stopped && running.get(key) === entry
		void startStream(appId, sub, isLive).then(
			(u) => {
				if (stopped) u()
				else unsub = u
			},
			(error) => {
				// Drop the failed slot so a later diff can retry; surface the failure.
				if (running.get(key) === entry && !stopped) running.delete(key)
				onError(appId, errMessage(error))
			}
		)
	}

	// Resolve the trusted capability and open the host stream. Each emitted event
	// is dispatched as a `__sub/<to>` message (another reduce) — but only while the
	// stream is still live (`isLive`), so a late event from a torn-down watcher
	// never mutates state. A routing failure (the edge vanished after a reinstall)
	// surfaces via onError, like a command result.
	async function startStream(
		appId: AppId,
		sub: Subscription,
		isLive: () => boolean
	): Promise<() => void> {
		const declared = await resolve(appId, sub.capability)
		if (!declared) throw new Error(`undeclared capability: ${sub.capability}`)
		if (!subscribe) throw new Error('capability streams unavailable')
		const actor = `capability:${declared.id}`
		const deliver = (params: unknown) =>
			dispatch(appId, { type: `${SUB_EVENT_PREFIX}${sub.to}`, params, actor })
		const fail = (error: unknown) => onError(appId, errMessage(error))

		// A `coalesce` stream is a WAKE (see `Subscription`): while one event is being
		// reduced, later ones fold into a single trailing dispatch carrying the newest
		// payload. Without it a bursty host stream queues one dispatch PER event on the
		// app's queue — and every dispatch re-reads the bundle, clones state through the
		// isolate, and may commit — so a bulk fs operation grew that queue without bound
		// and starved everything else chained on it, including the host's GUI boot. Same
		// trailing single-flight shape as `runCoalesced` in kernel.command.ts.
		let running = false
		let trailing: { params: unknown } | undefined
		async function pump(first: unknown): Promise<void> {
			running = true
			try {
				let next: { params: unknown } | undefined = { params: first }
				while (next) {
					await deliver(next.params)
					next = isLive() ? trailing : undefined
					trailing = undefined
				}
			} finally {
				running = false
				trailing = undefined
			}
		}

		return subscribe(
			{
				appId,
				capability: declared.id,
				method: sub.method,
				args: sub.args,
				scopes: declared.scopes
			},
			(event) => {
				if (!isLive()) return
				if (!sub.coalesce) {
					void deliver(event).catch(fail)
					return
				}
				if (running) {
					trailing = { params: event }
					return
				}
				void pump(event).catch(fail)
			}
		)
	}

	function stop(appId: AppId): void {
		const running = subs.get(appId)
		if (!running) return
		for (const entry of running.values()) entry.stop()
		subs.delete(appId)
	}

	// Warm an app's streams from persisted state. A DO restart/reinstall drops the
	// in-memory set, so the kernel rehydrates lazily on the FIRST touch of an app.
	// The marker is set synchronously to dedupe; the reconcile runs in-queue so it
	// serializes with dispatch. No-op once warm — from there a state-changing
	// dispatch keeps the set converged.
	function ensure(appId: AppId): void {
		if (disposed || subs.has(appId) || !subscribe) return
		subs.set(appId, new Map())
		void enqueue(appId, async () => {
			const desired = await loadDesired(appId)
			if (desired) reconcile(appId, desired)
		}).catch((error) => onError(appId, errMessage(error)))
	}

	function dispose(): void {
		disposed = true
		for (const appId of [...subs.keys()]) stop(appId)
	}
}

function errMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
