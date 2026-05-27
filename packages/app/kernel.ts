import { chroot, type Volume } from '@justfiles/fs'
import type {
	Action,
	ActionMeta,
	AppBundle,
	AppManifest,
	DispatchResult,
	InstalledApp,
	RuntimeContext
} from './app.ts'
import { safeBundlePath } from './app.ts'
import { EVENT_ACTION_PREFIX } from './sdk.ts'

export type { Action, ActionMeta, AppBundle, AppManifest, BuiltinBundle } from './app.ts'
// `install(app: AppBundle)` and `dispatch(appId, action: Action)` are the
// kernel's API surface, so a host (frieren) needs these to wire a transport.
export { appBundleFromMemory, safeBundlePath } from './app.ts'

interface System {
	fs: Volume
	sandbox: GetSandbox
	clock: Clock
}

export type GetSandbox = (input: { appId: string; code: string }) => Promise<Sandbox>

export type Sandbox = {
	run(action: Action, ctx: RuntimeContext): Promise<DispatchResult<unknown>>
	actions?(): Promise<Record<string, ActionMeta>>
}
type Clock = object

type AppId = string
type Unsubscribe = () => void

export interface Kernel {
	install: (app: AppBundle) => Promise<AppId> // after install, we get stable appId
	uninstall: (appId: AppId) => Promise<void>
	subscribe: (handler: KernelEventHandler) => Unsubscribe
	dispatch: (appId: AppId, action: Action) => Promise<unknown>
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
	return {
		install,
		uninstall,
		dispatch,
		state,
		actions,
		subscribe,
		app,
		list,
		emit: emitChannel
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

	async function loadState(root: string): Promise<unknown> {
		const statePath = `${root}/data/state.json`
		try {
			if (await fs.exists(statePath)) return JSON.parse(text(await fs.readFile(statePath)))
		} catch {
			return undefined
		}
		return undefined
	}

	async function install(app: AppBundle): Promise<AppId> {
		await fs.mkdir('/applications', { recursive: true })

		const rawManifest = await app.manifest()
		const appId = rawManifest.id
		const root = appRoot(appId)
		const manifestPath = `${root}/manifest.json`
		const manifest: AppManifest = {
			...rawManifest,
			app: safeBundlePath(rawManifest.app),
			gui: rawManifest.gui ? safeBundlePath(rawManifest.gui) : undefined,
			cli: rawManifest.cli ? safeBundlePath(rawManifest.cli) : undefined,
			icon: rawManifest.icon ? safeBundlePath(rawManifest.icon) : undefined
		}

		await fs.mkdir(root, { recursive: true })
		for await (const rawPath of app.list()) {
			const path = safeBundlePath(rawPath)
			const parent = path.split('/').slice(0, -1).join('/')
			if (parent) await fs.mkdir(`${root}/${parent}`, { recursive: true })
			await fs.writeFile(`${root}/${path}`, await app.read(rawPath))
		}
		if (!(await fs.exists(`${root}/${manifest.app}`)))
			throw new Error(`missing app entry: ${manifest.app}`)
		if (manifest.gui && !(await fs.exists(`${root}/${manifest.gui}`))) {
			throw new Error(`missing gui entry: ${manifest.gui}`)
		}
		if (manifest.icon && !(await fs.exists(`${root}/${manifest.icon}`))) {
			throw new Error(`missing icon: ${manifest.icon}`)
		}
		await fs.writeFile(manifestPath, bytes(JSON.stringify(manifest)))

		// If the index is already warm, fold the new app's subscriptions in.
		// Otherwise we'll build it lazily on the first emit.
		if (subscriptionIndex) await indexApp(subscriptionIndex, appId)

		return appId
	}

	async function uninstall(appId: AppId): Promise<void> {
		await fs.rm(appRoot(appId), { recursive: true, force: true })
		dropFromIndex(appId)
	}

	async function dispatch(appId: AppId, action: Action): Promise<unknown> {
		const root = appRoot(appId)
		if (!(await fs.exists(root))) throw new Error(`app not found: ${appId}`)

		const app = await getApp(appId)
		if (!app) throw new Error(`app not found: ${appId}`)

		await fs.mkdir(`${root}/data/files`, { recursive: true })
		const statePath = `${root}/data/state.json`
		const current = await loadState(root)

		const saveState = (next: unknown): Promise<void> =>
			fs.writeFile(statePath, bytes(JSON.stringify(next)))

		// Validation runs inside the app bundle (defineApp), so it works
		// identically for in-process and remote sandboxes; the kernel just
		// loads and runs.
		const sb = await sandbox({ appId, code: text(await app.read(app.manifest.app)) })
		const out = await sb.run(action, {
			state: current,
			files: chroot(fs, `${root}/data/files`),
			setState: saveState
		})
		// Handlers populate `state`; queries don't. Only persist + push when
		// the action declared itself as a state-mutating handler — that's
		// what keeps query-style reads (e.g. Finder's readFile) from
		// ballooning state with file content.
		if (out.state !== undefined) {
			await saveState(out.state)
			emit({ type: 'app.update', appId, state: out.state as AppState })
		}
		return out.result
	}

	async function state(appId: AppId): Promise<unknown> {
		const root = appRoot(appId)
		if (!(await fs.exists(root))) throw new Error(`app not found: ${appId}`)
		return loadState(root)
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
