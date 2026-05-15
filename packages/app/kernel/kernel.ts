import type { Volume } from '@justfiles/fs'
import type { Action, AppBundle, InstalledApp } from './app'

interface System {
	fs: Volume
	sandbox: GetSandbox
	clock: Clock
}

export type GetSandbox = (code: string) => Promise<Sandbox>

export type Sandbox = {
	run(action: Action): Promise<unknown>
}
type Clock = object

type AppId = string
type Unsubscribe = () => void

interface Kernel {
	install: (app: AppBundle) => Promise<AppId> // after install, we get stable appId
	uninstall: (appId: AppId) => Promise<void>
	subscribe: (handler: KernelEventHandler) => Unsubscribe
	dispatch: (appId: AppId, action: Action) => Promise<unknown>
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

export function kernel({ fs, sandbox }: System): Kernel {
	return { install, uninstall, dispatch, subscribe }

	async function install(app: AppBundle): Promise<AppId> {
		await fs.mkdir('/applications', { recursive: true })

		const manifest = await app.manifest()
		const root = `/applications/${manifest.name}`
		const manifestPath = `${root}/manifest.json`
		const existing = (await fs.exists(manifestPath))
			? JSON.parse(text(await fs.readFile(manifestPath)))
			: null
		const appId = existing?.id ?? crypto.randomUUID()

		await fs.mkdir(root, { recursive: true })
		for await (const path of app.list()) {
			await fs.writeFile(`${root}/${path}`, await app.read(path))
		}
		await fs.writeFile(manifestPath, bytes(JSON.stringify({ id: appId, ...manifest })))

		const index = await getIndex()
		index[appId] = root
		await saveIndex(index)

		return appId
	}

	async function uninstall(appId: AppId): Promise<void> {
		const index = await getIndex()
		const root = index[appId]
		if (!root) return
		await fs.rm(root, { recursive: true, force: true })
		delete index[appId]
		await saveIndex(index)
	}

	async function dispatch(appId: AppId, _action: Action): Promise<unknown> {
		const app = await getApp(appId)
		if (!app) throw new Error(`app not found: ${appId}`)
		const sb = await sandbox(text(await app.read(app.manifest.fn)))
		return await sb.run(_action)
	}

	function subscribe(_handler: KernelEventHandler): Unsubscribe {
		throw new Error('not implemented')
	}

	async function getApp(appId: AppId): Promise<InstalledApp | null> {
		const root = (await getIndex())[appId]
		if (!root) return null
		return {
			manifest: JSON.parse(text(await fs.readFile(`${root}/manifest.json`))),
			read: (path) => fs.readFile(`${root}/${path}`)
		}
	}

	async function getIndex(): Promise<Record<AppId, string>> {
		const path = '/applications/index.json'
		if (!(await fs.exists(path))) return {}
		return JSON.parse(text(await fs.readFile(path)))
	}

	async function saveIndex(index: Record<AppId, string>): Promise<void> {
		await fs.writeFile('/applications/index.json', bytes(JSON.stringify(index)))
	}
}
