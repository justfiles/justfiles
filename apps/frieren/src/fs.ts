import { apiStorage, createFsClient as createCoreFsClient, type FsClient } from '@justfiles/core'
import { type SyncStatus, synced, type Volume } from '@justfiles/fs'
import { idbStorage } from '@justfiles/fs/storage/idb'

export type { FsClient, SyncStatus, Volume }

export type GetToken = () => Promise<string | null>

// A synced local volume: a browser-local replica that reconciles with the
// backend. Adds the sync lifecycle on top of the plain volume surface.
export type SyncedVolume = Volume & {
	flush(): Promise<void>
	pause(): void
	resume(): void
	destroy(): void
	status(): SyncStatus
	onStatusChange(fn: (status: SyncStatus) => void): () => void
}

function makeHeaders(getToken: GetToken) {
	return async () => {
		const token = await getToken()
		return { Authorization: `Bearer ${token ?? ''}` }
	}
}

export function createFsClient(getToken: GetToken): FsClient {
	return createCoreFsClient({ baseUrl: '/fs', headers: makeHeaders(getToken) })
}

// Local profiles own local storage, not Clerk users. A profile is a browser-local
// identity that holds one IDB replica; signing in attaches a remote user to it.
// Keeping the registry separate from auth lets local data survive sign-out and,
// later, lets the OS boot a profile with no auth at all (Phase 4d).
export type LocalProfile = {
	id: string
	remoteUserId: string
	lastOpenedAt: number
}

const REGISTRY_KEY = 'frieren-profiles'

function readRegistry(): LocalProfile[] {
	try {
		const raw = localStorage.getItem(REGISTRY_KEY)
		return raw ? (JSON.parse(raw) as LocalProfile[]) : []
	} catch {
		return []
	}
}

function writeRegistry(profiles: LocalProfile[]): void {
	localStorage.setItem(REGISTRY_KEY, JSON.stringify(profiles))
}

// Find (or create) the local profile that owns this remote user's storage, and
// mark it most-recently opened.
function profileForUser(remoteUserId: string): LocalProfile {
	const profiles = readRegistry()
	let profile = profiles.find((p) => p.remoteUserId === remoteUserId)
	if (!profile) {
		profile = { id: crypto.randomUUID(), remoteUserId, lastOpenedAt: Date.now() }
		profiles.push(profile)
	} else {
		profile.lastOpenedAt = Date.now()
	}
	writeRegistry(profiles)
	return profile
}

function forgetProfileEntry(id: string): void {
	writeRegistry(readRegistry().filter((p) => p.id !== id))
}

function dbName(profileId: string): string {
	return `frieren-fs-profile-${profileId}`
}

type Active = {
	profileId: string
	dbName: string
	local: ReturnType<typeof idbStorage>
	volume: Promise<SyncedVolume>
	teardown: () => void
}

let active: Active | null = null

// Singleton, per-profile synced volume. The app shell, OS provider, and
// onboarding all read/write one local replica, so there is exactly one sync loop
// per profile. A different profile releases the previous replica first.
export function getFsVolume(userId: string, getToken: GetToken): Promise<SyncedVolume> {
	const profile = profileForUser(userId)
	if (active && active.profileId === profile.id) return active.volume
	void releaseFsVolume({ flush: false })

	const name = dbName(profile.id)
	const local = idbStorage(name)
	const volume = (async () => {
		const remote = await apiStorage(createFsClient(getToken))
		// localFirst: return the local replica immediately and sync in the
		// background — boot does not block on first sync settling.
		return synced({ local, remote, lazyContent: true, localFirst: true })
	})()

	// Online-aware sync: stop pushing when the network drops, resume when it
	// returns, and flush pending writes to the backend before the tab goes away.
	const onOnline = () => void volume.then((v) => v.resume()).catch(() => {})
	const onOffline = () => void volume.then((v) => v.pause()).catch(() => {})
	const flush = () => void volume.then((v) => v.flush()).catch(() => {})
	const onHidden = () => {
		if (document.visibilityState !== 'visible') flush()
	}
	window.addEventListener('online', onOnline)
	window.addEventListener('offline', onOffline)
	window.addEventListener('pagehide', flush)
	document.addEventListener('visibilitychange', onHidden)

	active = {
		profileId: profile.id,
		dbName: name,
		local,
		volume,
		teardown: () => {
			window.removeEventListener('online', onOnline)
			window.removeEventListener('offline', onOffline)
			window.removeEventListener('pagehide', flush)
			document.removeEventListener('visibilitychange', onHidden)
		}
	}
	return volume
}

// Stop syncing and release the active replica WITHOUT deleting it. Called on
// sign-out / user switch — local profile data is preserved on this browser so the
// user can return to it. Per-profile DB names already prevent cross-user leakage,
// so there is nothing to delete for safety. Explicit user switches flush first;
// implicit auth teardown drops sync without using a possibly-new user's token.
export async function releaseFsVolume(options: { flush?: boolean } = {}): Promise<void> {
	const prev = active
	if (!prev) return
	active = null
	prev.teardown()
	const vol = await prev.volume.catch(() => null)
	if (options.flush ?? true) await vol?.flush().catch(() => {})
	else vol?.pause()
	vol?.destroy()
	prev.local.destroy()
}

// Explicit "forget this browser": release and permanently delete the active
// profile's local replica and registry entry. Sign-out alone never does this.
export async function forgetActiveProfile(): Promise<void> {
	const prev = active
	if (!prev) return
	const { profileId, dbName: name } = prev
	await releaseFsVolume({ flush: false })
	forgetProfileEntry(profileId)
	await deleteIdb(name)
}

// Force an immediate sync (push+pull) on the active volume. The capability
// socket's `dirty` push calls this so the agent's server-side writes land in
// the local replica at once instead of waiting for the next sync interval.
export function flushActiveVolume(): void {
	void active?.volume.then((v) => v.flush()).catch(() => {})
}

function deleteIdb(name: string): Promise<void> {
	return new Promise((resolve) => {
		const req = indexedDB.deleteDatabase(name)
		req.onsuccess = req.onerror = req.onblocked = () => resolve()
	})
}
