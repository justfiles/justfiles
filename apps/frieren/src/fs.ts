import { apiStorage, createFsClient as createCoreFsClient, type FsClient } from '@justfiles/core'
import { type SyncStatus as FsSyncStatus, synced, type Volume, volume } from '@justfiles/fs'
import { idbStorage } from '@justfiles/fs/storage/idb'

export type { FsClient, Volume }
export type SyncStatus = FsSyncStatus | 'local-only'

type SyncVolume = Awaited<ReturnType<typeof synced>>

export type ProfileVolume = Volume & {
	flush(): Promise<void>
	pause(): void
	resume(): void
	destroy(): void
	status(): SyncStatus
	onStatusChange(fn: (status: SyncStatus) => void): () => void
}

export type GetToken = () => Promise<string | null>

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
// identity that holds one IDB replica. The default local profile is the signed-out
// workspace; signed-in accounts are sibling profiles that can sync.
export type LocalProfile = {
	id: string
	remoteUserId?: string
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

// Profiles are selected from browser-local state before Clerk finishes loading.
// The most-recent profile is the current workspace; explicit sign-out makes the
// anonymous profile current.
function touchProfile(profiles: LocalProfile[], profile: LocalProfile): LocalProfile {
	profile.lastOpenedAt = Date.now()
	writeRegistry(profiles)
	return profile
}

function currentProfile(): LocalProfile {
	const profiles = readRegistry()
	const profile = [...profiles].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0]
	if (profile) return touchProfile(profiles, profile)
	const next: LocalProfile = { id: 'local', lastOpenedAt: Date.now() }
	profiles.push(next)
	writeRegistry(profiles)
	return next
}

function localProfile(): LocalProfile {
	const profiles = readRegistry()
	const profile =
		profiles.find((p) => !p.remoteUserId && p.id === 'local') ??
		[...profiles].filter((p) => !p.remoteUserId).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0]
	if (profile) return touchProfile(profiles, profile)
	const next: LocalProfile = { id: 'local', lastOpenedAt: Date.now() }
	profiles.push(next)
	writeRegistry(profiles)
	return next
}

// Find (or create) the local profile that owns a remote user, marking it opened.
function profileForUser(remoteUserId: string): LocalProfile {
	const profiles = readRegistry()
	let profile = profiles.find((p) => p.remoteUserId === remoteUserId)
	if (!profile) {
		profile = { id: crypto.randomUUID(), remoteUserId, lastOpenedAt: Date.now() }
		profiles.push(profile)
	}
	return touchProfile(profiles, profile)
}

function forgetProfileEntry(id: string): void {
	writeRegistry(readRegistry().filter((p) => p.id !== id))
}

function dbName(profileId: string): string {
	return `frieren-fs-profile-${profileId}`
}

type Active = {
	profileId: string
	remoteUserId?: string
	dbName: string
	local: ReturnType<typeof idbStorage>
	sync: SyncVolume | null
	volume: ProfileVolume
	status: SyncStatus
	unsubscribeSyncStatus?: () => void
	teardown: () => void
}

let active: Active | null = null
const statusListeners = new Set<() => void>()

function emitStatus(): void {
	for (const fn of statusListeners) fn()
}

function setActiveStatus(entry: Active, status: SyncStatus): void {
	if (entry.status === status) return
	entry.status = status
	emitStatus()
}

function createProfileVolume(localVolume: Volume, sync: () => SyncVolume | null): ProfileVolume {
	return {
		...localVolume,
		// `synced` only adds behavior Frieren needs for remote-backed reads:
		// lazy blob hydration. Writes/watch/stat can use the same local storage.
		readFile: (path) => sync()?.readFile(path) ?? localVolume.readFile(path),
		flush: () => sync()?.flush() ?? Promise.resolve(),
		pause: () => sync()?.pause(),
		resume: () => sync()?.resume(),
		destroy: () => sync()?.destroy(),
		status: activeStatus,
		onStatusChange: (fn) => onActiveStatusChange(() => fn(activeStatus()))
	}
}

function stopSync(entry: Active): void {
	entry.unsubscribeSyncStatus?.()
	entry.unsubscribeSyncStatus = undefined
	entry.sync?.pause()
	entry.sync?.destroy()
	entry.sync = null
	setActiveStatus(entry, 'local-only')
}

async function startSync(entry: Active, getToken: GetToken): Promise<void> {
	entry.unsubscribeSyncStatus?.()
	entry.sync?.destroy()
	entry.sync = null
	setActiveStatus(entry, 'connecting')
	const remote = await apiStorage(createFsClient(getToken))
	const syncVolume = await synced({
		local: entry.local,
		remote,
		lazyContent: true,
		localFirst: true
	})
	if (active !== entry) {
		syncVolume.destroy()
		return
	}
	entry.sync = syncVolume
	setActiveStatus(entry, syncVolume.status())
	entry.unsubscribeSyncStatus = syncVolume.onStatusChange((next) => {
		if (active === entry) setActiveStatus(entry, next)
	})
}

function setActive(
	profileId: string,
	name: string,
	local: ReturnType<typeof idbStorage>,
	remoteUserId?: string
): Active {
	const localVolume = volume(local)
	let entry: Active
	const managed = createProfileVolume(localVolume, () => entry.sync)

	// Online-aware sync: stop pushing when the network drops, resume when it
	// returns, and flush pending writes to the backend before the tab goes away.
	const onOnline = () => active === entry && entry.sync?.resume()
	const onOffline = () => active === entry && entry.sync?.pause()
	const flush = () => {
		if (active === entry) void entry.sync?.flush().catch(() => {})
	}
	const onHidden = () => {
		if (document.visibilityState !== 'visible') flush()
	}
	window.addEventListener('online', onOnline)
	window.addEventListener('offline', onOffline)
	window.addEventListener('pagehide', flush)
	document.addEventListener('visibilitychange', onHidden)

	entry = {
		profileId,
		remoteUserId,
		dbName: name,
		local,
		sync: null,
		volume: managed,
		status: 'local-only',
		teardown: () => {
			entry.unsubscribeSyncStatus?.()
			window.removeEventListener('online', onOnline)
			window.removeEventListener('offline', onOffline)
			window.removeEventListener('pagehide', flush)
			document.removeEventListener('visibilitychange', onHidden)
		}
	}
	active = entry
	emitStatus()
	return entry
}

function openProfileVolume(profile: LocalProfile): ProfileVolume {
	const name = dbName(profile.id)
	return setActive(profile.id, name, idbStorage(name), profile.remoteUserId).volume
}

function openLocalProfile(): ProfileVolume {
	return openProfileVolume(localProfile())
}

// Open the current browser profile's IDB volume. Remote profiles boot from their
// local replica immediately; auth later starts sync or switches after sign-out.
export function openProfile(): Promise<ProfileVolume> {
	if (active) return Promise.resolve(active.volume)
	return Promise.resolve(openProfileVolume(currentProfile()))
}

export function activeProfileId(): string | null {
	return active?.profileId ?? null
}

export function activeRemoteUserId(): string | null {
	return active?.remoteUserId ?? null
}

export function activeProfileHasRemoteUser(): boolean {
	return Boolean(activeRemoteUserId())
}

export function activeStatus(): SyncStatus {
	return active?.status ?? 'local-only'
}

export function onActiveStatusChange(fn: () => void): () => void {
	statusListeners.add(fn)
	return () => statusListeners.delete(fn)
}

// Switch to the signed-in account profile and start sync. Called when auth
// resolves — never a boot prerequisite. Do not auto-merge the local workspace
// into an account; keep it separate and switch/create the account profile.
export async function attachRemoteUser(userId: string, getToken: GetToken): Promise<ProfileVolume> {
	const cur = active
	if (cur?.remoteUserId === userId) {
		await startSync(cur, getToken)
		return cur.volume
	}

	// Switch to (or create) the profile that owns this user.
	await releaseFsVolume({ flush: false })
	const profile = profileForUser(userId)
	const entry = setActive(
		profile.id,
		dbName(profile.id),
		idbStorage(dbName(profile.id)),
		profile.remoteUserId
	)
	await startSync(entry, getToken)
	return entry.volume
}

// Sign-out switches back to the browser-local workspace. Account data stays on
// disk for that account profile, but it is no longer the active desktop.
export async function switchToLocalProfile(): Promise<ProfileVolume> {
	if (active && !activeProfileHasRemoteUser()) {
		stopSync(active)
		return active.volume
	}
	await releaseFsVolume({ flush: false })
	return openLocalProfile()
}

// Stop syncing and release the active replica WITHOUT deleting it. Called on
// user switch — local profile data is preserved on this browser so the user can
// return to it. Per-profile DB names already prevent cross-user leakage, so
// there is nothing to delete for safety.
export async function releaseFsVolume(options: { flush?: boolean } = {}): Promise<void> {
	const prev = active
	if (!prev) return
	active = null
	emitStatus()
	prev.teardown()
	if (options.flush ?? true) await prev.sync?.flush().catch(() => {})
	else prev.sync?.pause()
	prev.sync?.destroy()
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
	void active?.sync?.flush().catch(() => {})
}

function deleteIdb(name: string): Promise<void> {
	return new Promise((resolve) => {
		const req = indexedDB.deleteDatabase(name)
		req.onsuccess = req.onerror = req.onblocked = () => resolve()
	})
}
