import type { Volume } from '@justfiles/fs'
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

function scopedPath(root: string, path: string): string {
	if (!path.startsWith('/')) throw new Error(`path must be absolute: ${path}`)
	const parts: string[] = []
	for (const part of path.split('/')) {
		if (!part || part === '.') continue
		if (part === '..') {
			if (parts.length === 0) throw new Error(`path escapes app sandbox: ${path}`)
			parts.pop()
			continue
		}
		parts.push(part)
	}
	return parts.length ? `${root}/${parts.join('/')}` : root
}

function scopedVolume(fs: Volume, root: string): Volume {
	const at = (path: string) => scopedPath(root, path)
	return {
		stat: (path) => fs.stat(at(path)),
		lstat: (path) => fs.lstat(at(path)),
		exists: (path) => fs.exists(at(path)),
		getXattr: (path, name) => fs.getXattr(at(path), name),
		setXattr: (path, name, value) => fs.setXattr(at(path), name, value),
		listXattr: (path) => fs.listXattr(at(path)),
		removeXattr: (path, name) => fs.removeXattr(at(path), name),
		readFile: (path) => fs.readFile(at(path)),
		writeFile: (path, data) => fs.writeFile(at(path), data),
		appendFile: (path, data) => fs.appendFile(at(path), data),
		mkdir: (path, opts) => fs.mkdir(at(path), opts),
		readdir: (path) => fs.readdir(at(path)),
		rm: (path, opts) => fs.rm(at(path), opts),
		rename: (oldPath, newPath) => fs.rename(at(oldPath), at(newPath)),
		cp: (src, dest, opts) => fs.cp(at(src), at(dest), opts),
		symlink: async () => {
			throw new Error('symlink not supported in app sandbox')
		},
		readlink: (path) => fs.readlink(at(path)),
		chmod: (path, mode) => fs.chmod(at(path), mode),
		utimes: (path, mtimeNs) => fs.utimes(at(path), mtimeNs),
		scan: (path, visitor) =>
			fs.scan(at(path), async (realPath, stat) => {
				await visitor(realPath.slice(root.length) || '/', stat)
			})
	}
}

export function kernel({ fs, sandbox }: System): Kernel {
	return { install, uninstall, dispatch, subscribe }

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

		const sb = await sandbox(text(await app.read(app.manifest.fn)))
		const result = await sb.run(action, {
			state,
			files: scopedVolume(fs, `${root}/data/files`),
			setState: saveState
		})
		await saveState(result)
		return result
	}

	function subscribe(_handler: KernelEventHandler): Unsubscribe {
		throw new Error('not implemented')
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
