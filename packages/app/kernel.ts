import type { Volume } from '@justfiles/fs'
import type {
	ActionMeta,
	AppBundle,
	AppManifest,
	DispatchResult,
	InstalledApp,
	Message,
	RuntimeContext
} from './app.ts'
import { safeBundlePath } from './app.ts'
import { EVENT_ACTION_PREFIX } from './sdk.ts'

export type { ActionMeta, AppBundle, AppManifest, BuiltinBundle, Message } from './app.ts'
// `install(app: AppBundle)` and `dispatch(appId, message: Message)` are the
// kernel's API surface, so a host (frieren) needs these to wire a transport.
export { appBundleFromMemory, safeBundlePath } from './app.ts'

interface System {
	fs: Volume
	sandbox: GetSandbox
	clock: Clock
}

export type GetSandbox = (input: { appId: string; code: string }) => Promise<Sandbox>

export type Sandbox = {
	run(message: Message, ctx: RuntimeContext): Promise<DispatchResult<unknown>>
	actions?(): Promise<Record<string, ActionMeta>>
}
type Clock = object

type AppId = string
type Unsubscribe = () => void

export interface Kernel {
	install: (app: AppBundle) => Promise<AppId> // after install, we get stable appId
	uninstall: (appId: AppId) => Promise<void>
	subscribe: (handler: KernelEventHandler) => Unsubscribe
	dispatch: (appId: AppId, message: Message) => Promise<unknown>
	// Resolve once the app is idle (per-app queue drained) at a committed
	// version >= `seq`. The monotonic `seq` rides on every `app.update` event.
	// This is the quiescence primitive procedures (later phases) wait on; the
	// GUI never calls it.
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

function appRoot(appId: AppId): string {
	if (!/^[A-Za-z0-9]+([.-][A-Za-z0-9]+)*$/.test(appId)) throw new Error(`invalid app id: ${appId}`)
	return `/applications/${appId}`
}

export function kernel({ fs, sandbox }: System): Kernel {
	const handlers = new Set<KernelEventHandler>()
	// channel -> apps that declared an `on` handler for it. Lazily populated
	// on first emit by scanning installed apps' action keys; kept fresh by
	// install/uninstall. In-memory only — recomputed on DO boot.
	let subscriptionIndex: Map<string, Set<AppId>> | undefined
	// Per-app serialization. `queues` holds each app's tail promise so every
	// dispatch (GUI, agent, capability event) runs to completion before the
	// next begins — without this, two concurrent messages are a lost-update
	// read-modify-write. `seqs` is the monotonic committed version, in-memory
	// and recomputed from zero on boot (like `subscriptionIndex`).
	const queues = new Map<AppId, Promise<void>>()
	const seqs = new Map<AppId, number>()
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

	async function settled(appId: AppId, seq: number, opts?: { timeout?: number }): Promise<unknown> {
		const deadline = opts?.timeout ? Date.now() + opts.timeout : Number.POSITIVE_INFINITY
		// Drain the queue until it stops advancing (no new work was enqueued
		// while we awaited the tail). Once idle, the committed version must be
		// >= seq; if it isn't, nothing pending will ever reach it.
		while (true) {
			const tail = queues.get(appId)
			await (tail ?? Promise.resolve()).catch(() => {})
			if (queues.get(appId) === tail) {
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

		return appId
	}

	async function uninstall(appId: AppId): Promise<void> {
		await fs.rm(appRoot(appId), { recursive: true, force: true })
		await fs.rm(`/state/${appId}.json`, { force: true })
		await fs.rm(`/data/${appId}`, { recursive: true, force: true })
		dropFromIndex(appId)
	}

	// Public dispatch is serialized per app; the actual work is `dispatchNow`.
	function dispatch(appId: AppId, message: Message): Promise<unknown> {
		return enqueue(appId, () => dispatchNow(appId, message))
	}

	async function dispatchNow(appId: AppId, message: Message): Promise<unknown> {
		const root = appRoot(appId)
		if (!(await fs.exists(root))) throw new Error(`app not found: ${appId}`)

		const app = await getApp(appId)
		if (!app) throw new Error(`app not found: ${appId}`)

		await fs.mkdir('/state', { recursive: true })
		const statePath = `/state/${appId}.json`
		const current = await loadState(appId)

		const saveState = (next: unknown): Promise<void> =>
			fs.writeFile(statePath, bytes(JSON.stringify(next)))

		// Validation runs inside the app bundle (defineApp), so it works
		// identically for in-process and remote sandboxes; the kernel just
		// loads and runs.
		const sb = await sandbox({ appId, code: text(await app.read(app.manifest.app)) })
		const out = await sb.run(message, {
			state: current,
			setState: saveState
		})
		// Handlers populate `state`; queries don't. Only persist + push when
		// the action declared itself as a state-mutating handler — that's
		// what keeps query-style reads (e.g. Finder's readFile) from
		// ballooning state with file content.
		if (out.state !== undefined) {
			await saveState(out.state)
			const seq = (seqs.get(appId) ?? 0) + 1
			seqs.set(appId, seq)
			emit({ type: 'app.update', appId, state: out.state as AppState, seq })
		}
		return out.result
	}

	async function state(appId: AppId): Promise<unknown> {
		const root = appRoot(appId)
		if (!(await fs.exists(root))) throw new Error(`app not found: ${appId}`)
		return loadState(appId)
	}

	async function actions(appId: AppId): Promise<Record<string, ActionMeta>> {
		const all = await allActions(appId)
		// Event handlers (`__event/*`) are kernel-internal — they exist so the
		// subscription index can find them; agents/tooling should not see them
		// in the public action list.
		const out: Record<string, ActionMeta> = {}
		for (const type in all) {
			if (type.startsWith(EVENT_ACTION_PREFIX)) continue
			out[type] = all[type] as ActionMeta
		}
		return out
	}

	async function allActions(appId: AppId): Promise<Record<string, ActionMeta>> {
		const installed = await getApp(appId)
		if (!installed) throw new Error(`app not found: ${appId}`)
		const sb = await sandbox({
			appId,
			code: text(await installed.read(installed.manifest.app))
		})
		return (await sb.actions?.()) ?? {}
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
