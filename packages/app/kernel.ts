import type { Volume } from '@justfiles/fs'
import type {
	ActionMeta,
	AppBundle,
	AppManifest,
	DispatchResult,
	InstalledApp,
	Message,
	RawAppHandle,
	RuntimeContext,
	Subscription
} from './app.ts'
import { apps } from './kernel.app.ts'
import { capabilities } from './kernel.capability.ts'
import { commandRuntime } from './kernel.command.ts'
import { stateStore } from './kernel.state.ts'
import { subscriptionRuntime } from './kernel.subscription.ts'

export type {
	ActionMeta,
	AppBundle,
	AppHandle,
	AppManifest,
	BuiltinBundle,
	Message,
	RawAppHandle
} from './app.ts'
// `install(app: AppBundle)` and `dispatch(appId, message: Message)` are the
// kernel's API surface, so a host (frieren) needs these to wire a transport.
export { appBundleFromMemory, safeBundlePath } from './app.ts'

interface System {
	fs: Volume
	sandbox: GetSandbox
	clock: Clock
	// The host's capability executor. The kernel owns it — apps never receive
	// it directly. Before each call the kernel attaches the app's DECLARED
	// scopes (not what the isolate claims) and its appId, so a compromised
	// isolate cannot escalate scope or reach an undeclared capability.
	capabilityInvoke?: HostCapabilityInvoke
	// The host's stream opener (Part D) — the streaming dual of `capabilityInvoke`.
	// The kernel calls it to keep a `subscriptions(state)` stream alive, attaching
	// the same trusted scopes/appId; `emit` feeds each event back into the reducer.
	// Returns the unsubscribe the kernel calls when the stream leaves the set.
	capabilityStream?: HostCapabilityStream
}

export type HostCapabilityInvoke = (req: {
	appId: string
	capability: string
	method: string
	input: unknown
	scopes: readonly string[]
	actor?: string
}) => Promise<unknown>

export type HostCapabilityStream = (
	req: {
		appId: string
		capability: string
		method: string
		input: unknown
		scopes: readonly string[]
	},
	emit: (event: unknown) => void
) => Promise<() => void>

export type GetSandbox = (input: { appId: string; code: string }) => Promise<Sandbox>

export type Sandbox = {
	run(message: Message, ctx: RuntimeContext): Promise<DispatchResult<unknown>>
	actions?(): Promise<Record<string, ActionMeta>>
	// Declared capabilities (local name → { id, scopes }). The kernel reads
	// these to attach trusted scopes; mirrors `actions()` as a bundle accessor.
	capabilities?(): Promise<Record<string, { id: string; scopes: readonly string[] }>>
	// Run a declared procedure (Part C). The kernel builds the `app` handle and
	// invokes this OUTSIDE the dispatch queue; the handle's `dispatch`/`read`
	// round-trip back into the kernel.
	runProcedure?(name: string, params: unknown, app: RawAppHandle): Promise<unknown>
	// The streams the given state declares (Part D). The kernel calls this after
	// every commit (and on boot) to diff the live stream set. Absent → no streams.
	subscriptions?(state: unknown): Promise<Subscription[]>
}
type Clock = object

type AppId = string
type Unsubscribe = () => void

export interface Kernel {
	install: (app: AppBundle) => Promise<AppId> // after install, we get stable appId
	uninstall: (appId: AppId) => Promise<void>
	subscribe: (handler: KernelEventHandler) => Unsubscribe
	dispatch: (appId: AppId, message: Message) => Promise<unknown>
	// Resolve once the app is idle — the per-app queue is drained AND no command
	// is in flight — at a committed version >= `seq`. A command runs outside the
	// queue and re-enters its result as a fresh message, so quiescence means the
	// whole emit→run→result cascade has settled. The monotonic `seq` rides on
	// every `app.update` event. This is the quiescence primitive procedures
	// (later phases) wait on; the GUI never calls it.
	settled: (appId: AppId, seq: number, opts?: { timeout?: number }) => Promise<unknown>
	state: (appId: AppId) => Promise<unknown> // current persisted state (for push snapshots)
	actions: (appId: AppId) => Promise<Record<string, ActionMeta>>
	app: (appId: AppId) => Promise<InstalledApp> // manifest (entry paths) + read assets by path
	list: () => Promise<AppManifest[]> // installed-app catalog for the host launcher
}

type AppState = object

type KernelEventHandler = (event: Event) => void

// ----- events -----

type Event =
	| {
			type: 'app.update'
			appId: string
			state: AppState
			// Monotonic per-app version, bumped on each committed state write.
			// Push consumers can order/dedupe by it; `settled` waits on it.
			seq: number
	  }
	| {
			type: 'app.error'
			appId: string
			error: string
	  }
	| {
			type: 'system.error'
			error: string
	  }

// ------------------

function text(data: Uint8Array): string {
	return new TextDecoder().decode(data)
}

export function kernel({
	fs,
	sandbox,
	capabilityInvoke: hostInvoke,
	capabilityStream: hostStream
}: System): Kernel {
	// The app store owns the `/applications/<id>` bundle layout; the state store
	// owns each app's authoritative state + commit version; the capability resolver
	// owns the local-name → trusted { id, scopes } boundary. The kernel orchestrates
	// the rest (commands, streams) on top of them.
	const store = apps(fs)
	const states = stateStore(fs)
	const caps = capabilities(async (appId) => (await loadSandbox(appId)).capabilities?.() ?? {})
	// The command runtime (Part B) runs an edge's emitted Command off-queue and
	// re-enters its Result via `dispatch`. It owns the in-flight count `settled`
	// waits on (via `commands.pending`).
	const commands = commandRuntime({
		resolve: caps.resolve,
		hostInvoke,
		dispatch,
		onError: (appId, error) => emit({ type: 'app.error', appId, error })
	})
	// The subscription reconciler (Part D) keeps the streams an app's state
	// declares alive, re-entering each event via `dispatch`. `loadDesired` rebuilds
	// the set from persisted state when warming from boot.
	const subs = subscriptionRuntime({
		resolve: caps.resolve,
		hostStream,
		dispatch,
		enqueue,
		loadDesired: async (appId) => {
			if (!(await store.has(appId))) return null
			const sb = await loadSandbox(appId)
			return (await sb.subscriptions?.(await states.current(appId))) ?? []
		},
		onError: (appId, error) => emit({ type: 'app.error', appId, error })
	})
	const handlers = new Set<KernelEventHandler>()
	// Per-app serialization. `queues` holds each app's tail promise so every
	// dispatch (GUI, agent, capability event) runs to completion before the next
	// begins. The reduce runs in an out-of-process isolate, so `sb.run` is async:
	// the read-modify-write straddles that await, and without serialization two
	// concurrent messages are a lost update (see the kernel concurrency test). So
	// the queue is the correctness primitive that keeps the state store's in-memory
	// copy consistent across the async reduce.
	const queues = new Map<AppId, Promise<void>>()
	// Per-app set of procedure names (Part C), derived once from the bundle's
	// action meta (kind 'procedure'). Lets `dispatch` route a procedure call off
	// the queue without an `actions()` RPC per dispatch. Memoized in-memory,
	// recomputed on boot, dropped on (re)install/uninstall.
	const procNames = new Map<AppId, Promise<Set<string>>>()
	return {
		install,
		uninstall,
		dispatch,
		settled,
		state,
		actions,
		subscribe,
		app,
		list
	}

	// Chain `task` after the app's current tail so per-app work is strictly
	// serialized. The stored tail always resolves (errors are swallowed there)
	// so one failed dispatch never wedges the queue; the returned promise still
	// carries the real result/rejection to the caller.
	function enqueue<T>(appId: AppId, task: () => Promise<T>): Promise<T> {
		const prev = queues.get(appId) ?? Promise.resolve()
		const run = prev.then(task, task)
		queues.set(
			appId,
			run.then(
				() => {},
				() => {}
			)
		)
		return run
	}

	// Load the app's sandbox: read its compiled entry and hand it to the host's
	// `GetSandbox`. The adapters content-address the isolate, so repeated loads
	// of the same bytes reuse it. Shared by dispatch, `allActions`, and the
	// command executor.
	async function loadSandbox(appId: AppId): Promise<Sandbox> {
		const installed = await store.get(appId)
		if (!installed) throw new Error(`app not found: ${appId}`)
		return sandbox({ appId, code: text(await installed.read(installed.manifest.app)) })
	}

	// The procedure names an app declares (Part C). Filtered from the bundle's
	// action meta; memoized so routing in `dispatch` is a synchronous set lookup
	// after the first (shared) load. The shared promise keeps concurrent first
	// dispatches in registration order, so enqueue ordering is preserved.
	function proceduresOf(appId: AppId): Promise<Set<string>> {
		let cached = procNames.get(appId)
		if (!cached) {
			cached = (async () => {
				const meta = await allActions(appId)
				const set = new Set<string>()
				for (const type in meta) if (meta[type]?.kind === 'procedure') set.add(type)
				return set
			})()
			procNames.set(appId, cached)
		}
		return cached
	}

	// Kernel-mediated capability invocation for a procedure's `app.invoke(...)`.
	// Same trust boundary as the command executor: the app names a LOCAL
	// capability, the kernel resolves the trusted id + declared scopes — never
	// the isolate.
	async function invokeCapability(
		appId: AppId,
		capability: string,
		method: string,
		input: unknown,
		actor?: string
	): Promise<unknown> {
		const declared = await caps.resolve(appId, capability)
		if (!declared) throw new Error(`undeclared capability: ${capability}`)
		if (!hostInvoke) throw new Error('capability execution unavailable')
		return hostInvoke({
			appId,
			capability: declared.id,
			method,
			input,
			scopes: declared.scopes,
			actor
		})
	}

	async function settled(appId: AppId, seq: number, opts?: { timeout?: number }): Promise<unknown> {
		const deadline = opts?.timeout ? Date.now() + opts.timeout : Number.POSITIVE_INFINITY
		// Wait out both the queue and any in-flight command until neither advances:
		// a queued task may enqueue more, and a command (run off-queue) re-enters
		// its result as a fresh dispatch. Idle means the queue didn't move while we
		// waited AND no command is outstanding. Once idle the committed version
		// must be >= seq; if it isn't, nothing pending will ever reach it.
		while (true) {
			const tail = queues.get(appId)
			const pendingCommand = commands.pending(appId)
			await Promise.all([
				(tail ?? Promise.resolve()).catch(() => {}),
				pendingCommand ?? Promise.resolve()
			])
			if (queues.get(appId) === tail && !commands.pending(appId)) {
				if (states.seq(appId) >= seq) return state(appId)
				throw new Error(
					`settled: app ${appId} idle at seq ${states.seq(appId)}, never reached ${seq}`
				)
			}
			if (Date.now() > deadline) throw new Error(`settled: timeout waiting for app ${appId}`)
		}
	}

	function emit(event: Event): void {
		// Snapshot: a handler may unsubscribe (e.g. SSE connection close)
		// while we iterate.
		for (const handler of [...handlers]) handler(event)
	}

	async function install(app: AppBundle): Promise<AppId> {
		const appId = await store.install(app)
		// The bundle changed — its declared capabilities, procedures, and
		// `subscriptions(state)` may have too. Drop the memoized caps/procs and stop
		// the running streams, then re-warm against the NEW bundle so streams the
		// installed state declares (incl. an unconditional `init` stream) come up
		// without waiting for a first dispatch/snapshot (Part D).
		caps.forget(appId)
		procNames.delete(appId)
		subs.stop(appId)
		subs.ensure(appId)
		return appId
	}

	async function uninstall(appId: AppId): Promise<void> {
		await store.uninstall(appId)
		// State and per-app data outlive the bundle dir, and the memoized
		// caps/procs/streams are keyed off it — tear them all down here, the one
		// place that crosses the stores into the runtime subsystems.
		await states.drop(appId)
		await fs.rm(`/data/${appId}`, { recursive: true, force: true })
		subs.stop(appId)
		caps.forget(appId)
		procNames.delete(appId)
	}

	// Public dispatch. The queue is occupied SYNCHRONOUSLY (before any await) so a
	// fire-and-forget `dispatch` is immediately visible to `settled`. The queued
	// router then decides: a procedure (Part C) is a caller that must block
	// nothing — it is kicked off OUTSIDE the queue and the slot returns at once,
	// so it never deadlocks against its own `settled`. A plain message runs
	// serialized via `dispatchNow`; the agent default is that a plain agent
	// dispatch which changed state resolves with the SETTLED state (act →
	// converged model), while the GUI gets the immediate result and renders via
	// push.
	function dispatch(appId: AppId, message: Message): Promise<unknown> {
		// First touch of this app (post-boot/reinstall) warms its streams, so a
		// procedure-only or non-state-changing dispatch still rehydrates them.
		subs.ensure(appId)
		let settle!: (value: unknown) => void
		let reject!: (error: unknown) => void
		const result = new Promise<unknown>((res, rej) => {
			settle = res
			reject = rej
		})
		enqueue(appId, async () => {
			if ((await proceduresOf(appId)).has(message.type)) {
				// Off-queue: kick it off, return so the slot frees immediately.
				runProcedure(appId, message).then(settle, reject)
				return
			}
			const committed = await dispatchNow(appId, message)
			// Settle off-queue too — `settled` waits for the queue to drain, so
			// awaiting it inside the slot would deadlock.
			if (message.actor === 'agent' && committed.state !== undefined)
				settled(appId, committed.seq).then(settle, reject)
			else settle(committed.result)
		}).catch(reject)
		return result
	}

	type Committed = { result: unknown; state?: unknown; seq: number }

	async function dispatchNow(appId: AppId, message: Message): Promise<Committed> {
		if (!(await store.has(appId))) throw new Error(`app not found: ${appId}`)

		// Read authoritative state from memory (hydrated from fs once). The queue
		// serializes per app, so between this read and the commit below no other
		// dispatch for this app runs — the read-modify-write is atomic despite
		// `sb.run` being async.
		const current = await states.current(appId)

		// Validation runs inside the app bundle (defineApp), so it works
		// identically for in-process and remote sandboxes. The bundle's dispatch
		// is a pure reduce over `state` — effects ride out as command data, so the
		// kernel hands it only the current state.
		const sb = await loadSandbox(appId)
		const out = await sb.run(message, { state: current })
		// A public edge populates `state`; a procedure-routed read does not. Only
		// commit + push when the transition produced a next state — that keeps
		// caller-scoped reads (e.g. Finder's readFile) from ballooning state.
		let seq = states.seq(appId)
		if (out.state !== undefined) {
			// Write-through commit returns the new monotonic version.
			seq = await states.commit(appId, out.state)
			emit({ type: 'app.update', appId, state: out.state as AppState, seq })
			// State changed → the declared stream set may have too (Part D). The
			// bundle folded it into `out.subscriptions` (same isolate, no extra RPC);
			// diff it in-queue — host starts are fire-and-forget.
			subs.reconcile(appId, out.subscriptions ?? [])
		}
		// A pure-core edge may emit a command. Run it after the state is
		// committed and OUTSIDE this critical section, so a slow capability
		// can't stall the queue; its result re-enters as a `__cmd/<to>` message.
		if (out.command) commands.schedule(appId, out.command, message.actor)
		return { result: out.result, state: out.state, seq }
	}

	// Run a procedure (Part C). The handle drives the reducer (each `dispatch`
	// re-enters the per-app queue and reports its `seq`), waits via `settled`,
	// and reads capabilities through the kernel — all without the procedure
	// itself occupying the queue, so a long procedure never freezes the GUI.
	async function runProcedure(appId: AppId, message: Message): Promise<unknown> {
		const sb = await loadSandbox(appId)
		if (!sb.runProcedure) throw new Error(`procedures unsupported by sandbox: ${appId}`)
		const handle: RawAppHandle = {
			state: await states.current(appId),
			dispatch: (m) => enqueue(appId, () => dispatchNow(appId, m)).then(({ seq }) => ({ seq })),
			settled: (seq, opts) => settled(appId, seq, opts),
			invoke: (capability, method, input) =>
				invokeCapability(appId, capability, method, input, message.actor)
		}
		return sb.runProcedure(message.type, message.params, handle)
	}

	async function state(appId: AppId): Promise<unknown> {
		if (!(await store.has(appId))) throw new Error(`app not found: ${appId}`)
		// Boot/connect path: a host snapshotting state is the first touch after a DO
		// restart, so warm the app's streams from persisted state (Part D). Fire and
		// forget — the snapshot itself doesn't depend on the streams being live yet.
		subs.ensure(appId)
		return states.current(appId)
	}

	async function actions(appId: AppId): Promise<Record<string, ActionMeta>> {
		// Agent first-touch is often listing tools before it dispatches — warm
		// streams here too so they don't stay cold until the first action.
		subs.ensure(appId)
		const all = await allActions(appId)
		const out: Record<string, ActionMeta> = {}
		for (const type in all) {
			// 'gui' procedures are for the GUI client only — keep them off the
			// agent's tool surface (Part C audience).
			if (all[type]?.audience === 'gui') continue
			out[type] = all[type] as ActionMeta
		}
		return out
	}

	async function allActions(appId: AppId): Promise<Record<string, ActionMeta>> {
		return (await (await loadSandbox(appId)).actions?.()) ?? {}
	}

	function subscribe(handler: KernelEventHandler): Unsubscribe {
		handlers.add(handler)
		return () => handlers.delete(handler)
	}

	async function app(appId: AppId): Promise<InstalledApp> {
		const installed = await store.get(appId)
		if (!installed) throw new Error(`app not found: ${appId}`)
		return installed
	}

	function list(): Promise<AppManifest[]> {
		return store.list()
	}
}
