import { chroot, type Volume } from '@justfiles/fs'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Action, AppBundle, Context, InstalledApp } from './app'

interface System {
	fs: Volume
	sandbox: GetSandbox
	clock: Clock
}

export type GetSandbox = (code: string) => Promise<Sandbox>

export type Sandbox = {
	run(action: Action, ctx: Context): Promise<unknown>
	schemas: Record<string, StandardSchemaV1>
}
type Clock = object

type AppId = string
type Unsubscribe = () => void

interface Kernel {
	install: (app: AppBundle) => Promise<AppId> // after install, we get stable appId
	uninstall: (appId: AppId) => Promise<void>
	subscribe: (handler: KernelEventHandler) => Unsubscribe
	dispatch: (appId: AppId, action: Action) => Promise<unknown>
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
	return { install, uninstall, dispatch, subscribe, app }

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
		let state: unknown
		try {
			if (await fs.exists(statePath)) state = JSON.parse(text(await fs.readFile(statePath)))
		} catch {
			state = undefined
		}

		async function saveState(next: unknown): Promise<void> {
			state = next
			await fs.writeFile(statePath, bytes(JSON.stringify(state)))
		}

		const sb = await sandbox(text(await app.read(app.manifest.app)))

		// Validate at the trust boundary, before entering the app. The
		// handler receives the parsed output; the app does no validation.
		let params = action.params
		const schema = sb.schemas[action.type]
		if (schema) {
			const r = await schema['~standard'].validate(params)
			if (r.issues)
				throw new Error(
					`invalid params for ${action.type}: ${r.issues.map((i) => i.message).join('; ')}`
				)
			params = r.value
		}

		const result = await sb.run(
			{ ...action, params },
			{ state, files: chroot(fs, `${root}/data/files`), setState: saveState }
		)
		await saveState(result)
		return result
	}

	function subscribe(_handler: KernelEventHandler): Unsubscribe {
		throw new Error('not implemented')
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
