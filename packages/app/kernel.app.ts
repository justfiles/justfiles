import type { Volume } from '@justfiles/fs'
import type { AppBundle, AppManifest, InstalledApp } from './app.ts'
import { isMountedFile, safeBundlePath } from './app.ts'
import { trashBundle } from './trash.ts'

type AppId = string

// Fetches one of a hosted app's MOUNTED files by absolute URL — the GUI, the icon,
// assets. Injected because it is a host concern (the browser's `fetch` in frieren),
// and optional because a host that only ever runs reducers never mounts anything: the
// DO reads `manifest.app`, which is in the volume by construction.
export type FetchAsset = ((url: string) => Promise<Uint8Array>) & {
	// A browser cache may have persisted a response before this layer verifies its
	// manifest pin. Let the host remove that exact entry on mismatch.
	evict?: (url: string) => Promise<void>
}

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

// Did this fail because the path is not there? The volume reports a missing path the way
// POSIX does, whichever storage is under it.
const missing = (error: unknown): boolean =>
	error instanceof Error && error.message.includes('ENOENT')

// Where the origin serves one mounted file. Shared by the reader and by uninstall's
// eviction, so the two can never address the same byte differently.
const assetUrl = (manifest: AppManifest, path: string): string =>
	`${manifest.baseUrl?.replace(/\/$/, '')}/${path}`

/**
 * The app store: the host fs is the source of truth for what is INSTALLED, laid out
 * under `/applications/<id>`. What lives there depends on the manifest (see
 * `AppManifest`):
 *
 *   hosted (`baseUrl`) — the record and the REDUCER. Everything else is MOUNTED from
 *                        the origin through the host's HTTP cache, so GUI/assets never
 *                        replicate while the headless kernel stays durable.
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
	// Remove the installed app. State/data the bundle accreted at runtime are the
	// kernel's to tear down — this drops only the bundle.
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
			// Park the previous bundle, if one is there. The rename IS the test: `exists` reads
			// a cached dirent, which outlives a bundle removed behind this volume's back — a
			// second host process over the same store, or a crash between these two renames —
			// and asking first would then walk into a rename of a path that is already gone,
			// failing every later install of that app the same way.
			try {
				await fs.rename(root, backup)
				backedUp = true
			} catch (e) {
				if (!missing(e)) throw e
			}
			await fs.rename(tmp, root)
		} catch (e) {
			await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
			if (backedUp && !(await fs.exists(root))) await fs.rename(backup, root).catch(() => {})
			throw e
		}
		if (backedUp) {
			await evictMounted(backup, manifest).catch(() => {})
			await fs.rm(backup, { recursive: true, force: true }).catch(() => {})
		}
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
		// Move the app into a dated /trash folder with one atomic rename rather than a
		// recursive rm. `rename` commits as one transaction (journaling the whole subtree
		// as delete-old + put-new), so a concurrent observer — e.g. the launcher's
		// reconcile, fired by the volume's structural watch — never sees a half-deleted
		// bundle it would try to "repair"/resurrect. The bytes survive under /trash until
		// the retention sweep drops that day (see trash.ts). A bundle that is already gone
		// is nothing to trash — see the note on install's backup rename.
		let trashed: string
		try {
			trashed = await trashBundle(fs, root, appId)
		} catch (e) {
			if (missing(e)) return
			throw e
		}
		await evictMounted(trashed).catch(() => {})
	}

	// A hosted app's payload is in the HOST's cache, not the volume, so trashing the
	// bundle leaves those bytes behind — per ORIGIN, which every profile then pays for
	// and none can name. Read the URLs from the root that was moved so a racing install
	// cannot switch the bundle between the snapshot and the rename. A replacement keeps
	// URLs named by the committed manifest; uninstall drops them all.
	//
	// Best-effort, like the mount-time call: a host with no browser cache passes no
	// `evict`, and a cache that refuses must not fail the uninstall. Reinstall is
	// unaffected — a release is immutable, so a re-fetch returns the same verified bytes.
	async function evictMounted(root: string, current?: AppManifest): Promise<void> {
		const evict = fetchAsset?.evict
		if (!evict) return
		const keep = new Set(current ? mountedUrls(current) : [])
		const manifest: AppManifest = JSON.parse(text(await fs.readFile(`${root}/manifest.json`)))
		await Promise.all(
			mountedUrls(manifest)
				.filter((url) => !keep.has(url))
				.map(evict)
		)
	}

	function mountedUrls(manifest: AppManifest): string[] {
		return Object.keys(manifest.files ?? {})
			.filter((path) => isMountedFile(manifest, path))
			.map((path) => assetUrl(manifest, path))
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
	 * One file of a hosted app, fetched from its pinned origin.
	 *
	 * Browser hosts put their service worker and HTTP cache in front of `fetchAsset`;
	 * the synced volume holds only the manifest and reducer. Integrity is still
	 * checked here before bytes execute, whether the response came from the network
	 * or the service worker.
	 *
	 * It is also why a device can run an app it only ever received over sync. The record
	 * travels with the app, so "what should be here" needs no catalog of this host's own
	 * — the case that used to leave a device serving one version's GUI against another
	 * version's reducer.
	 */
	async function mount(manifest: AppManifest, path: string): Promise<Uint8Array> {
		const pinned = manifest.files?.[path]
		if (!fetchAsset) throw new Error(`no asset fetcher: cannot mount ${manifest.id}/${path}`)
		const url = assetUrl(manifest, path)
		const data = await fetchAsset(url)
		if (pinned) {
			try {
				await verify(manifest.id, path, data, pinned)
			} catch (error) {
				await fetchAsset.evict?.(url).catch(() => {})
				throw error
			}
		}
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
					? mount(manifest, safe)
					: fs.readFile(`${root}/${safe}`)
			}
		}
	}
}

// Integrity check on a mounted file: the manifest pins each file's `sha256-<hex>`
// over the exact bytes the origin should serve. Verified before the bytes execute,
// so a compromised or confused origin cannot substitute a payload —
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
