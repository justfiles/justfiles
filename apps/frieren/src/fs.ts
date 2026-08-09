import { PROFILE_PATH, SOUL_PATH } from '@justfiles/agent/defaults'
import {
	createFsClient as createCoreFsClient,
	type FsClient,
	remoteSyncReplica
} from '@justfiles/core'
import { type SyncStatus as FsSyncStatus, synced, type Volume, volume } from '@justfiles/fs'
import { idbStorage } from '@justfiles/fs/storage/idb'
import { FileType } from '@justfiles/fs/types'

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
	// Whether the one-time "bring your local work into this account" offer was
	// resolved for this account profile. Absent = never asked.
	migration?: 'migrated' | 'dismissed'
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
	// CLIENT<->SERVER: inject a factory that builds the HTTP `SyncReplica` speaking
	// the /fs path wire, bound to the clientId `synced()` owns (so the server-stamped
	// origin matches pull's excludeOrigin). Passing a `Storage` here would be read as
	// a two-folder P2P peer and fail (no path journal).
	const client = createFsClient(getToken)
	const syncVolume = await synced({
		local: entry.local,
		remote: ({ clientId, generation, lineageId }) =>
			remoteSyncReplica(client, { clientId, generation, lineageId }),
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

// ── Local → account data migration ───────────────────────────────────────
// A user who plays as the signed-out (anonymous) profile and then signs up is
// offered a one-time copy of that work into the fresh account. Explicit, never a
// silent merge and never a boot gate: the offer only fires when the account is
// genuinely new (its synced volume holds no user content) and the local profile
// does. The decision is recorded on the account profile so we never ask twice.

// User content lives OUTSIDE these reserved runtime prefixes. Apps can claim any
// other top-level prefix (per-app /data, the shared /notes knowledge base, …), so
// a denylist is more robust than an allowlist and needs no per-app knowledge.
const RESERVED_TOP_LEVEL = new Set(['.state', 'applications', 'private', 'state', 'system'])
// Copied subtree: user data + personalized identity only — never the sync journal, the
// `/private` tree (credentials, the active-AI selection, and the app cache, which
// refills from its origin), app bundles, or per-app UI state.
const MIGRATE_SKIP = ['/.state', '/private', '/applications', '/state']
// The two identity files the DO seeds as `seeded: true` defaults — the only paths
// a migration is allowed to overwrite (with the user's personalized version).
const IDENTITY_PATHS = new Set([SOUL_PATH, PROFILE_PATH])

// The anonymous (signed-out) profile's DB name, resolved WITHOUT touching
// lastOpenedAt — this is a read-only migration source, not a profile switch.
function anonymousProfileId(): string {
	const profiles = readRegistry()
	const profile =
		profiles.find((p) => !p.remoteUserId && p.id === 'local') ??
		[...profiles].filter((p) => !p.remoteUserId).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0]
	return profile?.id ?? 'local'
}

function openLocalSource(): { volume: Volume; destroy: () => void } {
	const storage = idbStorage(dbName(anonymousProfileId()))
	return { volume: volume(storage), destroy: () => storage.destroy() }
}

// A soul/profile file is "personalized" once the user overwrites the seeded
// default — the default carries `seeded: true` in frontmatter (agent-defaults).
async function isPersonalized(vol: Volume, path: string): Promise<boolean> {
	if (!(await vol.exists(path))) return false
	const text = new TextDecoder().decode(await vol.readFile(path))
	return !/^seeded:\s*true\s*$/m.test(text)
}

// Whether a volume holds anything worth migrating: a top-level entry outside the
// reserved prefixes (e.g. /data, /notes) or a personalized identity file.
async function hasUserContent(vol: Volume): Promise<boolean> {
	const entries = await vol.readdir('/').catch(() => [])
	if (entries.some((e) => !RESERVED_TOP_LEVEL.has(e.name))) return true
	return (await isPersonalized(vol, SOUL_PATH)) || (await isPersonalized(vol, PROFILE_PATH))
}

// Resolve once the entry's FIRST sync settles (its local replica now mirrors the
// DO). `synced` cycles syncing→synced on success and syncing→error on failure
// (including offline), so we resolve true on synced and false on error /
// switch-away — a transient first-cycle error just defers the offer to the next
// attach.
function waitForSynced(entry: Active): Promise<boolean> {
	if (entry.status === 'synced') return Promise.resolve(true)
	return new Promise((resolve) => {
		const off = onActiveStatusChange(() => {
			if (active !== entry || entry.status === 'error') {
				off()
				resolve(false)
			} else if (entry.status === 'synced') {
				off()
				resolve(true)
			}
		})
	})
}

// True iff we should offer migration: the active profile is a freshly-synced
// account with NO user content, the anonymous profile HAS content, and no
// decision was recorded yet. Safe by construction — an account that already has
// data (e.g. created on another device) reads as non-empty, so we never clobber.
export async function shouldOfferMigration(): Promise<boolean> {
	const acct = active
	if (!acct?.remoteUserId) return false
	if (readRegistry().find((p) => p.id === acct.profileId)?.migration) return false
	if (!(await waitForSynced(acct))) return false
	if (active !== acct) return false
	if (await hasUserContent(acct.volume)) return false
	const source = openLocalSource()
	try {
		return await hasUserContent(source.volume)
	} finally {
		source.destroy()
	}
}

function recordMigration(profileId: string, outcome: 'migrated' | 'dismissed'): void {
	const profiles = readRegistry()
	const entry = profiles.find((p) => p.id === profileId)
	if (!entry) return
	entry.migration = outcome
	writeRegistry(profiles)
}

// Record "start fresh" — never offer this account again.
export function dismissMigration(): void {
	if (active?.remoteUserId) recordMigration(active.profileId, 'dismissed')
}

let migrating: Promise<void> | null = null

// Copy the anonymous profile's user data + personalized identity into the active
// (synced) account volume; the writes land as fresh creates that sync up to the
// DO. Copy, not move — the local profile is left intact. Records 'migrated' on
// success so the offer never repeats; a failure leaves the decision unrecorded so
// the user can retry. Re-entrant calls share the in-flight run.
export function migrateLocalProfileInto(): Promise<void> {
	if (migrating) return migrating
	const acct = active
	if (!acct?.remoteUserId) return Promise.reject(new Error('migration requires an account profile'))
	migrating = (async () => {
		const source = openLocalSource()
		try {
			await copyUserData(source.volume, acct.volume)
			// Record + flush against the CAPTURED account, not the current `active`: the
			// user can switch profiles during a long copy, and both the decision flag and
			// the flush must land on the account that actually received the files.
			recordMigration(acct.profileId, 'migrated')
			await acct.sync?.flush().catch(() => {})
		} finally {
			source.destroy()
			migrating = null
		}
	})()
	return migrating
}

// fullScan is BFS, so `scan` visits a directory before its contents — mkdir the
// dir, then writeFile children into it. Per-path conflict policy: the offer is
// non-blocking, so between the freshness check and confirmation the account can
// gain content (the user makes a note; another device syncs one in). So NEVER
// clobber an existing destination path — the one exception is replacing the
// account's still-seeded identity default with the user's personalized soul/
// profile, which is the whole point of migrating identity.
async function copyUserData(src: Volume, dst: Volume): Promise<void> {
	const skip = (p: string) => MIGRATE_SKIP.some((s) => p === s || p.startsWith(`${s}/`))
	await src.scan('/', async (path, stat) => {
		if (path === '/' || skip(path)) return
		if (stat.type === FileType.Directory) {
			await dst.mkdir(path, { recursive: true }).catch(() => {})
			return
		}
		if (stat.type !== FileType.Regular) return
		if ((await dst.exists(path)) && !(await replacesSeededIdentity(src, dst, path))) return
		await dst.writeFile(path, await src.readFile(path))
	})
}

// True only for an identity file whose account copy is still the seeded default
// and whose local copy the user personalized — the sole allowed overwrite.
async function replacesSeededIdentity(src: Volume, dst: Volume, path: string): Promise<boolean> {
	if (!IDENTITY_PATHS.has(path)) return false
	return (await isPersonalized(src, path)) && !(await isPersonalized(dst, path))
}

function deleteIdb(name: string): Promise<void> {
	return new Promise((resolve) => {
		const req = indexedDB.deleteDatabase(name)
		// Resolve only once the delete TRULY completes. Resolving on `onblocked` (the
		// previous behaviour) let the caller's `location.reload()` race ahead and abort
		// the still-pending delete, so the local replica survived a factory reset — its
		// stale sync state then stalled the next bootstrap. `releaseFsVolume`'s
		// destroy() already closed the connection, so a transient block clears itself.
		req.onsuccess = req.onerror = () => resolve()
		req.onblocked = () =>
			console.warn(`[factoryReset] IndexedDB "${name}" delete blocked — close other tabs`)
	})
}

// ── Server-coordinated volume reset ──────────────────────────────────────────
// Surfaced in the sync-status menu (DesktopShell). "Take theirs" and "take mine"
// are intents on the synced volume — the state machine (and the POST /fs/reset it
// drives) lives in `synced()`. Only "factory reset" is app-level: it wipes the
// server AND nukes local IDB, which no library-level reset can do.

// "Take theirs" — discard this device's local replica and re-pull the server's
// volume. Purely client-side (the marker under /.state survives, so the server is
// adopted verbatim without reseeding built-ins). Synced profiles only.
export async function resetTakeTheirs(): Promise<void> {
	const sync = active?.sync
	if (!sync) throw new Error('“take theirs” requires a synced profile')
	await sync.takeTheirs()
}

// "Take mine" — make this device's volume the new server baseline; every other
// device converges to it over ordinary sync. The reset is a small atomic server
// op (truncate + bump); the republish then rides the normal resilient loop — so a
// closed tab / dropped network just resumes, and it can take as long as it needs.
export async function resetTakeMine(): Promise<void> {
	const sync = active?.sync
	if (!sync) throw new Error('“take mine” requires a synced profile')
	await sync.takeMine()
}

// "Factory reset" — wipe server + local, then reseed built-ins. A synced profile
// wipes the server first; both paths delete local IDB and reload, so `seedBuiltins`
// re-materialises the built-ins against the now-empty server and pushes them as
// the new baseline.
export async function factoryReset(getToken: GetToken): Promise<void> {
	const prev = active
	if (!prev) return
	if (prev.remoteUserId) {
		// `wipe` is not part of the sync layer's reset (it discards content too), so
		// it goes over the same typed /fs/reset route directly.
		const res = await createFsClient(getToken).reset.$post({
			json: {
				mode: 'wipe',
				fromGeneration: prev.sync?.generation() ?? 1,
				operationId: crypto.randomUUID()
			}
		})
		if (!res.ok) throw new Error(`factory reset failed: ${res.status}`)
	}
	const name = prev.dbName
	await releaseFsVolume({ flush: false })
	await deleteIdb(name)
	location.reload()
}
