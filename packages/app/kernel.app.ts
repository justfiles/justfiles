import type { Volume } from '@justfiles/fs'
import { cachePath } from '@justfiles/fs/sync-replica'
import type { AppBundle, AppManifest, InstalledApp } from './app.ts'
import { INSTALL_HASH_PATH, isCachedBundleFile, safeBundlePath } from './app.ts'
import { trashBundle } from './trash.ts'

type AppId = string

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
// previous one until the swap succeeds. In the cache lane for BOTH residencies:
// staged bytes are the definitive local-only file — they exist solely to be renamed
// away, and no peer has any use for them at this path. Keeping them out of
// `/system/tmp` means an install never churns the wire with a put-then-delete at a
// synced path, which is what a synced staging dir did for every devkit install.
//
// NOT `/private`: that lane means "nobody else may have these" and carries three
// dependencies that bundle-sized subtrees would violate — the agent's shell
// deny-list, `reset.ts`'s BFS (written for "a handful of small JSON files"), and
// `sync-replica.ts`'s documented per-account-credential contract. Staging is
// reconstructible, not secret.
const INSTALL_TMP = cachePath('/system/tmp/app-installs')

const parentOf = (path: string): string => path.split('/').slice(0, -1).join('/')

// The volume path of one file of an installed bundle. `/.cache` mirrors the
// volume's own namespace, so this is the app root (or its mirror) plus the bundle
// path — a string concat, no lookup, and a missing file is just a missing file that
// `filesPresentAndMatch` turns into a repair.
export function bundleFilePath(
	appId: AppId,
	manifest: { app: string; assets?: AppManifest['assets'] },
	path: string
): string {
	const root = appRoot(appId)
	return isCachedBundleFile(manifest, path) ? `${cachePath(root)}/${path}` : `${root}/${path}`
}

// The app store: the host fs is the source of truth for installed bundles, laid
// out under `/applications/<id>` — plus, for a 'cached' app, the `/.cache` mirror
// of that same path holding the files a peer would never read (see `AppAssets`).
// Install is atomic per lane — staged in a tmp dir, the manifest rewritten with
// safe paths, then swapped in over a backup that is restored on any failure.
// Everything else is a read of an installed bundle. This module knows nothing
// about runtime state, capabilities, or streams; the kernel layers those on and
// owns the install/uninstall lifecycle that crosses into them (cache
// invalidation, stream re-warming, state teardown).
interface Apps {
	// Returns the stable appId; the kernel keys every other subsystem by it.
	install(bundle: AppBundle): Promise<AppId>
	// Remove the installed bundle from both lanes. State/data/caches the bundle
	// accreted at runtime are the kernel's to tear down — this drops only the bundle.
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
		const rawManifest = await app.manifest()
		const appId = rawManifest.id
		const manifest: AppManifest = {
			...rawManifest,
			assets: rawManifest.assets ?? 'synced',
			app: safeBundlePath(rawManifest.app),
			gui: rawManifest.gui ? safeBundlePath(rawManifest.gui) : undefined,
			cli: rawManifest.cli ? safeBundlePath(rawManifest.cli) : undefined,
			icon: rawManifest.icon ? safeBundlePath(rawManifest.icon) : undefined
		}
		const root = appRoot(appId)
		const installId = crypto.randomUUID()
		// One staging area per lane — both under `INSTALL_TMP`, differing only in which
		// root they commit into. A 'synced' app uses the first alone; a 'cached' one
		// splits its files across the two by the rule every reader resolves paths with
		// (`bundleFilePath`).
		const stage = (name: string) => ({
			tmp: `${INSTALL_TMP}/${appId}-${name}${installId}`,
			backup: `${INSTALL_TMP}/${appId}-${name}previous-${installId}`
		})
		const synced = { root, ...stage('') }
		const cache = { root: cachePath(root), ...stage('cache-') }
		const cached = manifest.assets === 'cached'
		// Cache lane FIRST: the manifest is the installed-app record, so committing the
		// synced root last means an interrupted install never leaves a live manifest
		// pointing at a half-written cache. The reverse — a fresh cache under the old
		// manifest — is just a hash miss the next reconcile repairs.
		const lanes = cached ? [cache, synced] : [synced]
		const laneOf = (path: string) => (isCachedBundleFile(manifest, path) ? cache : synced)
		const backedUp: typeof lanes = []
		const committed: typeof lanes = []

		try {
			for (const lane of lanes) await fs.mkdir(lane.tmp, { recursive: true })
			for await (const rawPath of app.list()) {
				const path = safeBundlePath(rawPath)
				const lane = laneOf(path)
				const parent = path.split('/').slice(0, -1).join('/')
				if (parent) await fs.mkdir(`${lane.tmp}/${parent}`, { recursive: true })
				await fs.writeFile(`${lane.tmp}/${path}`, await app.read(rawPath))
			}
			const staged = (path: string) => fs.exists(`${laneOf(path).tmp}/${path}`)
			if (!(await staged(manifest.app))) throw new Error(`missing app entry: ${manifest.app}`)
			if (manifest.gui && !(await staged(manifest.gui))) {
				throw new Error(`missing gui entry: ${manifest.gui}`)
			}
			if (manifest.icon && !(await staged(manifest.icon))) {
				throw new Error(`missing icon: ${manifest.icon}`)
			}
			await fs.writeFile(`${synced.tmp}/manifest.json`, bytes(JSON.stringify(manifest)))
			// Stamp the cache lane with the same install marker the synced lane carries.
			// The two lanes commit separately and only one of them replicates, so this is
			// what lets a reader ask "was this cache written by the bundle I have?" without
			// a catalog — see `cacheIsCurrent`.
			if (cached) {
				const marker = `${synced.tmp}/${INSTALL_HASH_PATH}`
				if (await fs.exists(marker)) {
					await fs.writeFile(`${cache.tmp}/${INSTALL_HASH_PATH}`, await fs.readFile(marker))
				}
			}

			for (const lane of lanes) {
				await fs.mkdir(parentOf(lane.root), { recursive: true })
				if (await fs.exists(lane.root)) {
					await fs.rename(lane.root, lane.backup)
					backedUp.push(lane)
				}
				await fs.rename(lane.tmp, lane.root)
				committed.push(lane)
			}
		} catch (e) {
			// An install is all-or-nothing ACROSS the lanes: undo any lane that swapped in
			// before a later one failed, then put each backup back. Every lane ends up
			// wholly the previous bundle, or wholly absent if there was none.
			for (const lane of lanes) {
				await fs.rm(lane.tmp, { recursive: true, force: true }).catch(() => {})
				if (committed.includes(lane))
					await fs.rm(lane.root, { recursive: true, force: true }).catch(() => {})
				if (backedUp.includes(lane)) await fs.rename(lane.backup, lane.root).catch(() => {})
			}
			throw e
		}
		for (const lane of backedUp)
			await fs.rm(lane.backup, { recursive: true, force: true }).catch(() => {})
		// A 'synced' (re)install owns the whole app: sweep a mirror left by a previous
		// 'cached' one so no orphan survives the flip.
		if (!cached) await fs.rm(cache.root, { recursive: true, force: true }).catch(() => {})

		return appId
	}

	async function uninstall(appId: AppId): Promise<void> {
		const root = appRoot(appId)
		// The cache holds no user data and no history, so it needs no trash semantics —
		// and a cache directory with no manifest beside it is trivially sweepable.
		await fs.rm(cachePath(root), { recursive: true, force: true }).catch(() => {})
		if (!(await fs.exists(root))) return
		// Move the bundle into a dated /trash folder with one atomic rename rather than a
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

	// Was this app's cache written by the bundle currently installed?
	//
	// The two lanes commit separately and only the synced one replicates, so they can
	// drift: a peer running a newer release installs v2, syncs down `manifest.json` +
	// `app.js` + `.apphash`, and this device is left holding a v1 GUI — or none at all,
	// for a built-in it never had. Its own catalog is older, so `decide` correctly
	// declines to downgrade and the cache is never repaired.
	//
	// `.apphash` folds every file's hash, gui.js included, so comparing the lanes'
	// copies answers the question with no catalog and no network: equal means the cache
	// belongs to this bundle, anything else (absent, stale) means it does not. Reads
	// then fail as MISSING rather than quietly serving a GUI from a different version,
	// which is what turns cross-release skew into the host's ordinary refill path.
	async function cacheIsCurrent(root: string): Promise<boolean> {
		const read = (at: string) => fs.readFile(`${at}/${INSTALL_HASH_PATH}`).catch(() => null)
		const [installed, cached] = await Promise.all([read(root), read(cachePath(root))])
		// No marker on either side is a bundle installed without one (a devkit draft, a
		// pre-marker install) — nothing to contradict, so the cache stands.
		if (!installed && !cached) return true
		return installed !== null && cached !== null && text(installed) === text(cached)
	}

	async function get(appId: AppId): Promise<InstalledApp | null> {
		const root = appRoot(appId)
		if (!(await fs.exists(root))) return null
		const manifest: AppManifest = JSON.parse(text(await fs.readFile(`${root}/manifest.json`)))
		const stale = manifest.assets === 'cached' && !(await cacheIsCurrent(root))
		return {
			manifest,
			// The manifest the caller just read IS the lane record, so a read resolves
			// without a second lookup: `app.js` from the synced root, `gui.js` from the
			// mirror when this app's assets are cached.
			read: async (path) => {
				const safe = safeBundlePath(path)
				const at = bundleFilePath(appId, manifest, safe)
				if (stale && at !== `${root}/${safe}`) {
					throw new Error(`app cache is stale: ${appId}/${safe}`)
				}
				return fs.readFile(at)
			}
		}
	}
}
