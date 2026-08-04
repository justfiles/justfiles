import type { Volume } from '@justfiles/fs'
import { cachePath } from '@justfiles/fs/sync-replica'
import type { AppBundle, AppManifest, InstalledApp } from './app.ts'
import { isMountedFile, safeBundlePath } from './app.ts'
import { trashBundle } from './trash.ts'

type AppId = string

// Fetches one of a hosted app's MOUNTED files by absolute URL — the GUI, the icon,
// assets. Injected because it is a host concern (the browser's `fetch` in frieren),
// and optional because a host that only ever runs reducers never mounts anything: the
// DO reads `manifest.app`, which is in the volume by construction.
export type FetchAsset = (url: string) => Promise<Uint8Array>

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text)
}

function text(data: Uint8Array): string {
	return new TextDecoder().decode(data)
}

// An app id maps to `/applications/<id>`. The id is validated here — it becomes
// a path segment, so a crafted id must not escape the applications root. A single
// leading dot is allowed as the "hidden" marker (see `hidden` in kernel.ts) — the
// required alphanumeric after it keeps `.`, `..`, and `../escape` rejected.
function appRoot(appId: AppId): string {
	if (!/^\.?[A-Za-z0-9]+([.-][A-Za-z0-9]+)*$/.test(appId))
		throw new Error(`invalid app id: ${appId}`)
	return `/applications/${appId}`
}

// Where install stages a bundle before committing it with a rename, and parks the
// previous one until the swap succeeds. Under `/private` — the host's local-only lane
// — because staged bytes exist solely to be renamed away and no peer has any use for
// them at this path. It also keeps an install from churning the wire with a
// put-then-delete, which a synced staging dir did for every locally-authored install.
// Not under `/private/cache`: staging is in flight, not a copy of anything.
const INSTALL_TMP = '/private/tmp/app-installs'

const parentOf = (path: string): string => path.split('/').slice(0, -1).join('/')

/**
 * The app store: the host fs is the source of truth for what is INSTALLED, laid out
 * under `/applications/<id>`. What lives there depends on the manifest (see
 * `AppManifest`):
 *
 *   hosted (`baseUrl`) — the record and the REDUCER. Everything else is MOUNTED from
 *                        the origin and cached at `/private/cache/applications/<id>/…`,
 *                        so the GUI and assets never replicate while the bytes a
 *                        headless kernel needs stay durable (see `isMountedFile`).
 *   local              — the bundle's files, copied in and replicated. The only
 *                        correct shape when there is no origin to refetch from.
 *
 * Install is atomic either way: staged in a tmp dir, the manifest rewritten with safe
 * paths, then swapped in over a backup that is restored on any failure — so a
 * concurrent observer never sees a half-installed bundle. Everything else is a read.
 * This module knows nothing about runtime state, capabilities, or streams; the kernel
 * layers those on and owns the install/uninstall lifecycle that crosses into them
 * (cache invalidation, stream re-warming, state teardown).
 */
interface Apps {
	// Returns the stable appId; the kernel keys every other subsystem by it.
	install(bundle: AppBundle): Promise<AppId>
	// Remove the installed app, cached payload included. State/data the bundle
	// accreted at runtime are the kernel's to tear down — this drops only the app.
	uninstall(appId: AppId): Promise<void>
	get(appId: AppId): Promise<InstalledApp | null>
	// Cheap "is this app installed?" check — the kernel guards dispatch/state on it
	// without paying the manifest read `get` does. Throws on an invalid id, like
	// the rest of the store.
	has(appId: AppId): Promise<boolean>
	list(): Promise<AppManifest[]>
}

export function apps(fs: Volume, fetchAsset?: FetchAsset): Apps {
	return { install, uninstall, get, has, list }

	async function install(app: AppBundle): Promise<AppId> {
		const rawManifest = await app.manifest()
		const appId = rawManifest.id
		const manifest: AppManifest = {
			...rawManifest,
			app: safeBundlePath(rawManifest.app),
			gui: rawManifest.gui ? safeBundlePath(rawManifest.gui) : undefined,
			cli: rawManifest.cli ? safeBundlePath(rawManifest.cli) : undefined,
			icon: rawManifest.icon ? safeBundlePath(rawManifest.icon) : undefined
		}
		const root = appRoot(appId)
		const installId = crypto.randomUUID()
		const tmp = `${INSTALL_TMP}/${appId}-${installId}`
		const backup = `${INSTALL_TMP}/${appId}-previous-${installId}`
		let backedUp = false

		try {
			await fs.mkdir(tmp, { recursive: true })
			// Stage whatever the bundle carries — which for a hosted app is just its
			// reducer, the rest being the origin's to serve on first read.
			for await (const rawPath of app.list()) {
				const path = safeBundlePath(rawPath)
				const parent = parentOf(path)
				if (parent) await fs.mkdir(`${tmp}/${parent}`, { recursive: true })
				await fs.writeFile(`${tmp}/${path}`, await app.read(rawPath))
			}
			await requireEntries(manifest, (path) => fs.exists(`${tmp}/${path}`))
			await fs.writeFile(`${tmp}/manifest.json`, bytes(JSON.stringify(manifest)))

			await fs.mkdir(parentOf(root), { recursive: true })
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
		// Whatever the previous version cached is now dead weight: the hashes this
		// manifest pins would reject it anyway, so drop it and reclaim the space rather
		// than wait for a read to notice.
		await fs.rm(cachePath(root), { recursive: true, force: true }).catch(() => {})

		return appId
	}

	// The declared entries have to actually exist. The reducer must be STAGED whatever
	// the shape — that is the promise the volume makes to a headless kernel — while a
	// mounted entry is not here yet, so the record's pinned file list stands in,
	// catching a manifest that names a `gui.js` the origin will never serve at install
	// time instead of at launch.
	async function requireEntries(
		manifest: AppManifest,
		staged: (path: string) => Promise<boolean>
	): Promise<void> {
		const present = async (path: string) =>
			(await staged(path)) || manifest.files?.[path] !== undefined
		if (!(await staged(manifest.app))) throw new Error(`missing app entry: ${manifest.app}`)
		if (manifest.gui && !(await present(manifest.gui)))
			throw new Error(`missing gui entry: ${manifest.gui}`)
		if (manifest.icon && !(await present(manifest.icon)))
			throw new Error(`missing icon: ${manifest.icon}`)
	}

	async function uninstall(appId: AppId): Promise<void> {
		const root = appRoot(appId)
		// The cache holds no user data and no history, so it needs no trash semantics —
		// and a cache directory with no manifest beside it is trivially sweepable.
		await fs.rm(cachePath(root), { recursive: true, force: true }).catch(() => {})
		if (!(await fs.exists(root))) return
		// Move the app into a dated /trash folder with one atomic rename rather than a
		// recursive rm. `rename` commits as one transaction (journaling the whole subtree
		// as delete-old + put-new), so a concurrent observer — e.g. the launcher's
		// reconcile, fired by the volume's structural watch — never sees a half-deleted
		// bundle it would try to "repair"/resurrect. The bytes survive under /trash until
		// the retention sweep drops that day (see trash.ts).
		await trashBundle(fs, root, appId)
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

	/**
	 * One file of a hosted app, from the cache when it holds the right bytes and from
	 * the origin when it does not.
	 *
	 * The pinned hash IS the cache key. The volume is content-addressed, so checking a
	 * cached file costs a `stat` rather than a re-hash — and because the check is against
	 * the hash the MANIFEST pins, a cache left behind by an older version can never be
	 * served as the current one. That is what makes eviction and refresh fall out for
	 * free: nothing needs to invalidate the cache, because bytes that no longer match
	 * the record simply stop being reachable.
	 *
	 * It is also why a device can run an app it only ever received over sync. The record
	 * travels with the app, so "what should be here" needs no catalog of this host's own
	 * — the case that used to leave a device serving one version's GUI against another
	 * version's reducer.
	 */
	async function mount(manifest: AppManifest, root: string, path: string): Promise<Uint8Array> {
		const pinned = manifest.files?.[path]
		const at = `${cachePath(root)}/${path}`
		if (pinned) {
			const stat = await fs.stat(at).catch(() => null)
			if (stat && `sha256-${stat.contentHash ?? ''}` === pinned) return fs.readFile(at)
		} else {
			const cached = await fs.readFile(at).catch(() => null)
			if (cached) return cached // unpinned: presence is all we can ask of it
		}
		if (!fetchAsset) throw new Error(`no asset fetcher: cannot mount ${manifest.id}/${path}`)
		const data = await fetchAsset(`${manifest.baseUrl?.replace(/\/$/, '')}/${path}`)
		if (pinned) await verify(manifest.id, path, data, pinned)
		// Best-effort: a failed cache write costs a refetch, never the read itself.
		await fs
			.mkdir(parentOf(at), { recursive: true })
			.then(() => fs.writeFile(at, data))
			.catch(() => {})
		return data
	}

	async function get(appId: AppId): Promise<InstalledApp | null> {
		const root = appRoot(appId)
		if (!(await fs.exists(root))) return null
		const manifest: AppManifest = JSON.parse(text(await fs.readFile(`${root}/manifest.json`)))
		return {
			manifest,
			read: async (path) => {
				const safe = safeBundlePath(path)
				return isMountedFile(manifest, safe)
					? mount(manifest, root, safe)
					: fs.readFile(`${root}/${safe}`)
			}
		}
	}
}

// Integrity check on a mounted file: the manifest pins each file's `sha256-<hex>`
// over the exact bytes the origin should serve. Verified before the bytes are cached
// or executed, so a compromised or confused origin cannot substitute a payload —
// the same guarantee the catalog gave at install time, now carried by the record.
async function verify(
	appId: string,
	path: string,
	data: Uint8Array,
	pinned: string
): Promise<void> {
	const buffer = data.buffer.slice(
		data.byteOffset,
		data.byteOffset + data.byteLength
	) as ArrayBuffer
	const digest = await crypto.subtle.digest('SHA-256', buffer)
	const actual = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
	if (`sha256-${actual}` !== pinned) throw new Error(`hash mismatch: ${appId}/${path}`)
}
