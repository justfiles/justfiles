import { chroot, type Volume } from '@justfiles/fs'
import type { Action, AppBundle, Context, InstalledApp } from './app'

interface System {
	fs: Volume
	sandbox: GetSandbox
	clock: Clock
}

export type GetSandbox = (code: string) => Promise<Sandbox>

export type Sandbox = {
	run(action: Action, ctx: Context): Promise<unknown>
}
type Clock = object

type AppId = string
type Unsubscribe = () => void

interface Kernel {
	install: (app: AppBundle) => Promise<AppId> // after install, we get stable appId
	uninstall: (appId: AppId) => Promise<void>
	subscribe: (handler: KernelEventHandler) => Unsubscribe
	dispatch: (appId: AppId, action: Action) => Promise<unknown>
	state: (appId: AppId) => Promise<unknown> // current persisted state (for push snapshots)
	app: (appId: AppId) => Promise<InstalledApp> // manifest (entry paths) + read assets by path
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
	return { install, uninstall, dispatch, state, subscribe, app }

	function emit(event: Event): void {
		// Snapshot: a handler may unsubscribe (e.g. SSE connection close)
		// while we iterate.
		for (const handler of [...handlers]) handler(event)
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

		const manifest = await app.manifest()
		const appId = manifest.id
		const root = appRoot(appId)
		const manifestPath = `${root}/manifest.json`

		await fs.mkdir(root, { recursive: true })
		for await (const path of app.list()) {
			await fs.writeFile(`${root}/${path}`, await app.read(path))
		}
		await fs.writeFile(manifestPath, bytes(JSON.stringify(manifest)))

		return appId
	}

	async function uninstall(appId: AppId): Promise<void> {
		await fs.rm(appRoot(appId), { recursive: true, force: true })
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
		const sb = await sandbox(text(await app.read(app.manifest.app)))
		const result = await sb.run(action, {
			state: current,
			files: chroot(fs, `${root}/data/files`),
			setState: saveState
		})
		await saveState(result)
		// State is push-only: every committed state change fans out to
		// subscribers, scoped by appId.
		emit({ type: 'app.update', appId, state: result as AppState })
		return result
	}

	async function state(appId: AppId): Promise<unknown> {
		const root = appRoot(appId)
		if (!(await fs.exists(root))) throw new Error(`app not found: ${appId}`)
		return loadState(root)
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

	async function getApp(appId: AppId): Promise<InstalledApp | null> {
		const root = appRoot(appId)
		if (!(await fs.exists(root))) return null
		return {
			manifest: JSON.parse(text(await fs.readFile(`${root}/manifest.json`))),
			read: (path) => fs.readFile(`${root}/${path}`)
		}
	}
}
