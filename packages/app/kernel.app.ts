import type { Volume } from '@justfiles/fs'
import type { AppBundle, AppManifest, InstalledApp } from './app.ts'
import { safeBundlePath } from './app.ts'

type AppId = string

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text)
}

function text(data: Uint8Array): string {
	return new TextDecoder().decode(data)
}

// An app id maps to `/applications/<id>`. The id is validated here — it becomes
// a path segment, so a crafted id must not escape the applications root.
function appRoot(appId: AppId): string {
	if (!/^[A-Za-z0-9]+([.-][A-Za-z0-9]+)*$/.test(appId)) throw new Error(`invalid app id: ${appId}`)
	return `/applications/${appId}`
}

// The app store: the host fs is the source of truth for installed bundles, laid
// out under `/applications/<id>`. Install is atomic — staged in a tmp dir, the
// manifest rewritten with safe paths, then swapped in over a backup that is
// restored on any failure. Everything else is a read of an installed bundle.
// This module knows nothing about runtime state, capabilities, or streams; the
// kernel layers those on and owns the install/uninstall lifecycle that crosses
// into them (cache invalidation, stream re-warming, state teardown).
interface Apps {
	// Returns the stable appId; the kernel keys every other subsystem by it.
	install(bundle: AppBundle): Promise<AppId>
	// Remove the installed bundle. State/data/caches the bundle accreted at
	// runtime are the kernel's to tear down — this drops only `/applications/<id>`.
	uninstall(appId: AppId): Promise<void>
	get(appId: AppId): Promise<InstalledApp | null>
	// Cheap "is this app installed?" check — the kernel guards dispatch/state on it
	// without paying the manifest read `get` does. Throws on an invalid id, like
	// the rest of the store.
	has(appId: AppId): Promise<boolean>
	list(): Promise<AppManifest[]>
}

export function apps(fs: Volume): Apps {
	return { install, uninstall, get, has, list }

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

		return appId
	}

	async function uninstall(appId: AppId): Promise<void> {
		await fs.rm(appRoot(appId), { recursive: true, force: true })
	}

	async function has(appId: AppId): Promise<boolean> {
		return fs.exists(appRoot(appId))
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

	async function get(appId: AppId): Promise<InstalledApp | null> {
		const root = appRoot(appId)
		if (!(await fs.exists(root))) return null
		return {
			manifest: JSON.parse(text(await fs.readFile(`${root}/manifest.json`))),
			read: (path) => fs.readFile(`${root}/${safeBundlePath(path)}`)
		}
	}
}
