import type { Volume } from '@justfiles/fs'
import type {
	ActionMeta,
	AppBundle,
	AppManifest,
	Command,
	DispatchResult,
	InstalledApp,
	Message,
	RawAppHandle,
	RuntimeContext
} from './app.ts'
import { safeBundlePath } from './app.ts'
import { CMD_RESULT_PREFIX, EVENT_ACTION_PREFIX } from './sdk.ts'

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
}

export type HostCapabilityInvoke = (req: {
	appId: string
	capability: string
	method: string
	input: unknown
	scopes: readonly string[]
	actor?: string
}) => Promise<unknown>

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
	// Notification-center entry point for capability impls. `channel` is
	// `<capabilityId>.<eventName>` (matches the contract's declared events);
	// the kernel dispatches a `__event/<channel>` synthetic action into each
	// app whose reducer declared an `on`-handler for it.
	emit: (channel: string, event: unknown) => Promise<void>
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

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text)
}

function text(data: Uint8Array): string {
	return new TextDecoder().decode(data)
}

// Shape a thrown value (or message) into the `Result` error a `fromResult`
// edge folds into state.
function errResult(error: unknown): { ok: false; error: { message: string } } {
	return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
}

function appRoot(appId: AppId): string {
	if (!/^[A-Za-z0-9]+([.-][A-Za-z0-9]+)*$/.test(appId)) throw new Error(`invalid app id: ${appId}`)
	return `/applications/${appId}`
}

export function kernel({ fs, sandbox, capabilityInvoke: hostInvoke }: System): Kernel {
	const handlers = new Set<KernelEventHandler>()
	// channel -> apps that declared an `on` handler for it. Lazily populated
	// on first emit by scanning installed apps' action keys; kept fresh by
	// install/uninstall. In-memory only — recomputed on DO boot.
	let subscriptionIndex: Map<string, Set<AppId>> | undefined
	// Per-app authoritative state, held in memory and written through to fs on
	// every commit (durability + DO hibernation). Lazily hydrated from fs on
	// first access; once cached, dispatch reads it directly instead of reloading
	// per message. In-memory only — rehydrated from fs on boot, like the maps
	// below. `.has()` distinguishes "not loaded" from "loaded, value undefined".
	const states = new Map<AppId, unknown>()
	// Per-app serialization. `queues` holds each app's tail promise so every
	// dispatch (GUI, agent, capability event) runs to completion before the next
	// begins. The plan retires this once the reduce is synchronous — but the
	// reduce runs in an out-of-process isolate, so `sb.run` is async: the
	// read-modify-write straddles that await, and without serialization two
	// concurrent messages are a lost update (see the kernel concurrency test). So
	// the queue stays as the correctness primitive; what phase 5 removes is the
	// per-dispatch fs reload — state is now the in-memory `states` cache above.
	// `seqs` is the monotonic committed version, in-memory and recomputed from
	// zero on boot (like `subscriptionIndex`).
	const queues = new Map<AppId, Promise<void>>()
	const seqs = new Map<AppId, number>()
	// Per-app declared capabilities (local name → { id, trusted scopes }), read
	// from the bundle. Memoized like `subscriptionIndex`/`seqs` — in-memory,
	// recomputed on boot, dropped on (re)install/uninstall since the bundle's
	// declarations can change.
	const declaredCaps = new Map<
		AppId,
		Promise<Record<string, { id: string; scopes: readonly string[] }>>
	>()
	// Per-app set of procedure names (Part C), derived once from the bundle's
	// action meta (kind 'procedure'). Lets `dispatch` route a procedure call off
	// the queue without an `actions()` RPC per dispatch. Memoized like
	// `declaredCaps` — recomputed on boot, dropped on (re)install/uninstall.
	const procNames = new Map<AppId, Promise<Set<string>>>()
	// In-flight command tracking. A command runs OUTSIDE the dispatch queue (so
	// a slow capability never blocks the GUI), but `settled` must still wait for
	// the whole cascade — emit → run → result re-enters → maybe emits again — to
	// quiesce. Each app counts its outstanding commands and holds a `done`
	// promise that resolves when the count returns to zero; `settled` awaits it.
	const inflight = new Map<AppId, { count: number; done: Promise<void>; wake: () => void }>()
	return {
		install,
		uninstall,
		dispatch,
		settled,
		state,
		actions,
		subscribe,
		app,
		list,
		emit: emitChannel
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
		const installed = await getApp(appId)
		if (!installed) throw new Error(`app not found: ${appId}`)
		return sandbox({ appId, code: text(await installed.read(installed.manifest.app)) })
	}

	// Resolve the app's declared capabilities (local name → { id, scopes }) from
	// the bundle. Memoized per app; populated from an already-loaded sandbox when
	// one is at hand (dispatch), otherwise it loads one (the out-of-queue command
	// executor). This is the kernel's trusted source — never the scopes an
	// isolate forwards.
	function appCapabilities(
		appId: AppId,
		sb?: Sandbox
	): Promise<Record<string, { id: string; scopes: readonly string[] }>> {
		let cached = declaredCaps.get(appId)
		if (!cached) {
			cached = (async () => (await (sb ?? (await loadSandbox(appId))).capabilities?.()) ?? {})()
			declaredCaps.set(appId, cached)
		}
		return cached
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
		const declared = (await appCapabilities(appId))[capability]
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

	// ----- command executor (Part B) -----
	// The only path that touches capabilities for the pure core. A transition
	// emits a Command as data; the kernel runs it AFTER persisting state and
	// OUTSIDE the dispatch queue (a slow capability must not block the GUI), then
	// routes the typed Result back as a `__cmd/<to>` message — another reduce.

	function commandStarted(appId: AppId): void {
		const entry = inflight.get(appId)
		if (entry) {
			entry.count++
			return
		}
		let wake!: () => void
		const done = new Promise<void>((resolve) => {
			wake = resolve
		})
		inflight.set(appId, { count: 1, done, wake })
	}

	function commandFinished(appId: AppId): void {
		const entry = inflight.get(appId)
		if (!entry || --entry.count > 0) return
		inflight.delete(appId)
		entry.wake()
	}

	// Kick a command off without awaiting it — awaiting here would deadlock the
	// queue (the result re-enters via `dispatch`, which chains on this same app's
	// tail). The in-flight count, bumped synchronously before we return, is what
	// `settled` waits on.
	function scheduleCommand(appId: AppId, command: Command, actor?: string): void {
		if (command.kind === 'none') return
		commandStarted(appId)
		void runCommand(appId, command, actor).finally(() => commandFinished(appId))
	}

	async function runCommand(appId: AppId, command: Command, actor?: string): Promise<void> {
		if (command.kind === 'none') return
		if (command.kind === 'batch') {
			// No ordering or atomicity across a batch; each sub-command routes its
			// own ok/err result, so one failure never drops a sibling.
			await Promise.all(command.commands.map((c) => runCommand(appId, c, actor)))
			return
		}
		// The app named a LOCAL capability; the kernel resolves the trusted id +
		// scopes from its declarations — never from the command data.
		const declared = (await appCapabilities(appId))[command.capability]
		const from = `capability:${declared?.id ?? command.capability}`
		if (!declared) {
			await deliver(
				appId,
				command.to,
				errResult(`undeclared capability: ${command.capability}`),
				from
			)
			return
		}
		if (!hostInvoke) {
			await deliver(appId, command.to, errResult('capability execution unavailable'), from)
			return
		}
		try {
			const value = await hostInvoke({
				appId,
				capability: declared.id,
				method: command.method,
				input: command.input,
				scopes: declared.scopes,
				actor
			})
			await deliver(appId, command.to, { ok: true, value }, from)
		} catch (error) {
			await deliver(appId, command.to, errResult(error), from)
		}
	}

	// Re-enter a command's Result as a `__cmd/<to>` message. A dangling result —
	// the `to` edge no longer exists (the app was reinstalled) or its reducer
	// threw — is surfaced as `app.error`, not allowed to crash the executor.
	async function deliver(
		appId: AppId,
		to: string,
		params: { ok: true; value: unknown } | { ok: false; error: { message: string } },
		actor: string
	): Promise<void> {
		try {
			await dispatch(appId, { type: `${CMD_RESULT_PREFIX}${to}`, params, actor })
		} catch (error) {
			emit({
				type: 'app.error',
				appId,
				error: error instanceof Error ? error.message : String(error)
			})
		}
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
			const commands = inflight.get(appId)?.done
			await Promise.all([
				(tail ?? Promise.resolve()).catch(() => {}),
				commands ?? Promise.resolve()
			])
			if (queues.get(appId) === tail && !inflight.has(appId)) {
				if ((seqs.get(appId) ?? 0) >= seq) return state(appId)
				throw new Error(
					`settled: app ${appId} idle at seq ${seqs.get(appId) ?? 0}, never reached ${seq}`
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

	async function ensureSubscriptionIndex(): Promise<Map<string, Set<AppId>>> {
		if (subscriptionIndex) return subscriptionIndex
		const idx = new Map<string, Set<AppId>>()
		for (const manifest of await list()) {
			await indexApp(idx, manifest.id)
		}
		subscriptionIndex = idx
		return idx
	}

	async function indexApp(idx: Map<string, Set<AppId>>, appId: AppId): Promise<void> {
		let meta: Record<string, ActionMeta>
		try {
			meta = await allActions(appId)
		} catch {
			return
		}
		for (const type in meta) {
			if (!type.startsWith(EVENT_ACTION_PREFIX)) continue
			const channel = type.slice(EVENT_ACTION_PREFIX.length)
			const set = idx.get(channel) ?? new Set<AppId>()
			set.add(appId)
			idx.set(channel, set)
		}
	}

	function dropFromIndex(appId: AppId): void {
		if (!subscriptionIndex) return
		for (const [channel, set] of subscriptionIndex) {
			set.delete(appId)
			if (set.size === 0) subscriptionIndex.delete(channel)
		}
	}

	async function emitChannel(channel: string, event: unknown): Promise<void> {
		const idx = await ensureSubscriptionIndex()
		const subs = idx.get(channel)
		if (!subs || subs.size === 0) return
		const syntheticType = `${EVENT_ACTION_PREFIX}${channel}`
		const actor = `capability:${channel.split('.')[0]}`
		// Errors from one subscriber must not stall the rest. The dispatch
		// path already emits `app.update` for successful runs and `app.error`
		// for failures, so observability isn't lost here.
		await Promise.all(
			[...subs].map((appId) =>
				dispatch(appId, { type: syntheticType, params: event, actor }).catch(() => undefined)
			)
		)
	}

	async function loadState(appId: AppId): Promise<unknown> {
		const statePath = `/state/${appId}.json`
		try {
			if (await fs.exists(statePath)) return JSON.parse(text(await fs.readFile(statePath)))
		} catch {
			return undefined
		}
		return undefined
	}

	// Authoritative state for an app: the in-memory copy if present, otherwise
	// hydrated from fs once and cached. Every reader (dispatch, procedure handle,
	// push snapshot) goes through here so they share one committed value with no
	// per-call fs read.
	async function currentState(appId: AppId): Promise<unknown> {
		if (states.has(appId)) return states.get(appId)
		const loaded = await loadState(appId)
		// A concurrent commit may have populated the cache while we read fs; keep
		// the newer authoritative value rather than clobbering it with the load.
		if (!states.has(appId)) states.set(appId, loaded)
		return states.get(appId)
	}

	// Write-through persistence: the caller updates `states` (authoritative),
	// this mirrors it to fs for durability and DO hibernation.
	async function saveState(appId: AppId, next: unknown): Promise<void> {
		await fs.mkdir('/state', { recursive: true })
		await fs.writeFile(`/state/${appId}.json`, bytes(JSON.stringify(next)))
	}

	async function install(app: AppBundle): Promise<AppId> {
		await fs.mkdir('/applications', { recursive: true })
		await fs.mkdir('/system/tmp/app-installs', { recursive: true })

		const rawManifest = await app.manifest()
		const appId = rawManifest.id
		const root = appRoot(appId)
		const installId = crypto.randomUUID()
		const tmp = `/system/tmp/app-installs/${appId}-${installId}`
		const backup = `/system/tmp/app-installs/${appId}-previous-${installId}`
		const manifestPath = `${tmp}/manifest.json`
		const manifest: AppManifest = {
			...rawManifest,
			app: safeBundlePath(rawManifest.app),
			gui: rawManifest.gui ? safeBundlePath(rawManifest.gui) : undefined,
			cli: rawManifest.cli ? safeBundlePath(rawManifest.cli) : undefined,
			icon: rawManifest.icon ? safeBundlePath(rawManifest.icon) : undefined
		}
		let backedUp = false

		try {
			await fs.mkdir(tmp, { recursive: true })
			for await (const rawPath of app.list()) {
				const path = safeBundlePath(rawPath)
				const parent = path.split('/').slice(0, -1).join('/')
				if (parent) await fs.mkdir(`${tmp}/${parent}`, { recursive: true })
				await fs.writeFile(`${tmp}/${path}`, await app.read(rawPath))
			}
			if (!(await fs.exists(`${tmp}/${manifest.app}`)))
				throw new Error(`missing app entry: ${manifest.app}`)
			if (manifest.gui && !(await fs.exists(`${tmp}/${manifest.gui}`))) {
				throw new Error(`missing gui entry: ${manifest.gui}`)
			}
			if (manifest.icon && !(await fs.exists(`${tmp}/${manifest.icon}`))) {
				throw new Error(`missing icon: ${manifest.icon}`)
			}
			await fs.writeFile(manifestPath, bytes(JSON.stringify(manifest)))

			if (await fs.exists(root)) {
				await fs.rename(root, backup)
				backedUp = true
			}
			await fs.rename(tmp, root)
		} catch (e) {
			await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
			if (backedUp && !(await fs.exists(root))) await fs.rename(backup, root).catch(() => {})
			throw e
		}
		if (backedUp) await fs.rm(backup, { recursive: true, force: true }).catch(() => {})

		// If the index is already warm, fold the new app's subscriptions in.
		// Otherwise we'll build it lazily on the first emit.
		dropFromIndex(appId)
		if (subscriptionIndex) await indexApp(subscriptionIndex, appId)
		// The bundle changed — its declared capabilities and procedures may have too.
		declaredCaps.delete(appId)
		procNames.delete(appId)

		return appId
	}

	async function uninstall(appId: AppId): Promise<void> {
		await fs.rm(appRoot(appId), { recursive: true, force: true })
		await fs.rm(`/state/${appId}.json`, { force: true })
		await fs.rm(`/data/${appId}`, { recursive: true, force: true })
		dropFromIndex(appId)
		states.delete(appId)
		declaredCaps.delete(appId)
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
		const root = appRoot(appId)
		if (!(await fs.exists(root))) throw new Error(`app not found: ${appId}`)

		// Read authoritative state from memory (hydrated from fs once). The queue
		// serializes per app, so between this read and the write-through below no
		// other dispatch for this app runs — the read-modify-write is atomic
		// despite `sb.run` being async.
		const current = await currentState(appId)

		// Validation runs inside the app bundle (defineApp), so it works
		// identically for in-process and remote sandboxes. The bundle's dispatch
		// is a pure reduce over `state` — effects ride out as command data, so the
		// kernel hands it only the current state.
		const sb = await loadSandbox(appId)
		const out = await sb.run(message, { state: current })
		// A public edge populates `state`; a procedure-routed read does not. Only
		// commit + push when the transition produced a next state — that keeps
		// caller-scoped reads (e.g. Finder's readFile) from ballooning state.
		let seq = seqs.get(appId) ?? 0
		if (out.state !== undefined) {
			// Authoritative in memory, written through to fs for durability.
			states.set(appId, out.state)
			await saveState(appId, out.state)
			seq += 1
			seqs.set(appId, seq)
			emit({ type: 'app.update', appId, state: out.state as AppState, seq })
		}
		// A pure-core edge may emit a command. Run it after the state is
		// committed and OUTSIDE this critical section, so a slow capability
		// can't stall the queue; its result re-enters as a `__cmd/<to>` message.
		if (out.command) scheduleCommand(appId, out.command, message.actor)
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
			state: await currentState(appId),
			dispatch: (m) => enqueue(appId, () => dispatchNow(appId, m)).then(({ seq }) => ({ seq })),
			settled: (seq, opts) => settled(appId, seq, opts),
			invoke: (capability, method, input) =>
				invokeCapability(appId, capability, method, input, message.actor)
		}
		return sb.runProcedure(message.type, message.params, handle)
	}

	async function state(appId: AppId): Promise<unknown> {
		const root = appRoot(appId)
		if (!(await fs.exists(root))) throw new Error(`app not found: ${appId}`)
		return currentState(appId)
	}

	async function actions(appId: AppId): Promise<Record<string, ActionMeta>> {
		const all = await allActions(appId)
		// Event handlers (`__event/*`) are kernel-internal — they exist so the
		// subscription index can find them; agents/tooling should not see them
		// in the public action list.
		const out: Record<string, ActionMeta> = {}
		for (const type in all) {
			if (type.startsWith(EVENT_ACTION_PREFIX)) continue
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
		const installed = await getApp(appId)
		if (!installed) throw new Error(`app not found: ${appId}`)
		return installed
	}

	async function list(): Promise<AppManifest[]> {
		if (!(await fs.exists('/applications'))) return []
		const entries = await fs.readdir('/applications')
		const manifests: AppManifest[] = []
		for (const { name } of entries) {
			const path = `/applications/${name}/manifest.json`
			if (await fs.exists(path)) manifests.push(JSON.parse(text(await fs.readFile(path))))
		}
		return manifests
	}

	async function getApp(appId: AppId): Promise<InstalledApp | null> {
		const root = appRoot(appId)
		if (!(await fs.exists(root))) return null
		return {
			manifest: JSON.parse(text(await fs.readFile(`${root}/manifest.json`))),
			read: (path) => fs.readFile(`${root}/${safeBundlePath(path)}`)
		}
	}
}
