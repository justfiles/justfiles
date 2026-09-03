import { PROFILE_PATH, SOUL_PATH } from '@justfiles/agent/defaults'
import { createFsClient as createCoreFsClient, type FsClient } from '@justfiles/core'
import { announceMount, type Volume, volume } from '@justfiles/fs'
import { httpStore } from '@justfiles/fs/http'
import { acquireStoreOwner, idbStore, sharedStore } from '@justfiles/fs/idb'
import { adoptOnce, migrateIdb } from '@justfiles/fs/migrate.idb'
import { BootstrapRequiredError } from '@justfiles/fs/peer'
import {
	type Cursor,
	ForeignCursorError,
	ROOT,
	type Store,
	verifiedBlobs
} from '@justfiles/fs/store'
import {
	authorOf,
	bootstrap,
	type CursorSlot,
	type SyncStatus as StoreSyncStatus,
	synced,
	versions
} from '@justfiles/fs/synced'
import {
	type PrivateSyncState,
	privateSyncState,
	type SyncStateLock,
	syncStateLock
} from '@justfiles/fs/syncState'
import { FileType } from '@justfiles/fs/types'
import { PRIVATE_MOUNT } from '../shared/private'

export type { FsClient, Volume }
export type SyncStatus = StoreSyncStatus | 'local-only'

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

// The seam, over the wire. `/store` rather than `/fs`: the old routes serve the old
// tables and this serves the one table the model has. The token is minted per REQUEST
// — Clerk's expires — so it goes in through the injected `fetch` rather than through
// the static header bag, which is read once at construction.
function remoteStore(getToken: GetToken, lock?: SyncStateLock): Store {
	return httpStore('/store', {
		fetch: async (url, init) => {
			const token = await getToken()
			const send = () =>
				fetch(url, {
					...init,
					headers: {
						...(init?.headers as Record<string, string>),
						Authorization: `Bearer ${token ?? ''}`
					}
				})
			return lock ? lock(send) : send()
		}
	})
}

// Values from the former localStorage layout seed the private files once. The files
// become authoritative as soon as they exist.
const legacySyncState = (profileId: string) => ({
	peerId: localStorage.getItem(`frieren-replica-${profileId}`) ?? undefined,
	relationship: {
		pull: localStorage.getItem(`frieren-fs-${profileId}-pull`) ?? undefined,
		push: localStorage.getItem(`frieren-fs-${profileId}-push`) ?? undefined,
		discard: localStorage.getItem(`frieren-fs-${profileId}-discard`) === '1'
	}
})

async function forgetSlots(profileId: string): Promise<void> {
	await profileSyncStateLock(profileId)(async () => {
		for (const suffix of ['pull', 'push', 'discard', 'replica'])
			localStorage.removeItem(
				suffix === 'replica' ? `frieren-replica-${profileId}` : `frieren-fs-${profileId}-${suffix}`
			)
	})
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
	// Whether the one pass from the old twin model has run for this profile. Copy-then-
	// swap, so an interrupted pass has broken nothing and re-running it costs a re-read
	// — but a pass that ran again after the volume was live would copy stale rows over
	// live ones, since rule 3 only makes an IDENTICAL row a no-op.
	adopted?: true
	// A remote wipe whose acknowledgement/local deletion has not completed. Kept
	// outside the IDB being deleted so a 503 retry reuses the committed operation.
	pendingFactoryReset?: { operationId: string; fromGeneration: number }
	/** Active synced-tree database after a crash-safe stale-cursor replacement. */
	storeDb?: string
	/** Prepared outside both databases; the old store stays active until this clears. */
	pendingBootstrap?: { freshDb: string }
	/** Old stores which became safe to delete only after the registry switched. */
	retiredStoreDbs?: string[]
}

const REGISTRY_KEY = 'frieren-profiles-v2'
const OWNER_LOCK = 'frieren-fs-owner'

// A browser tab is not a peer. Hold one owner across every profile switch and
// destructive pass; closing the page releases the Web Lock for the next tab.
let owning: Promise<void> | undefined
function ownBrowser(): Promise<void> {
	if (!owning) owning = acquireStoreOwner(OWNER_LOCK).then(() => undefined)
	return owning
}

const localSyncLocks = new Map<string, SyncStateLock>()
function profileSyncStateLock(profileId: string): SyncStateLock {
	const name = `frieren-sync-state-${profileId}`
	const locks = globalThis.navigator?.locks
	if (locks) return (body) => locks.request(name, body)
	let lock = localSyncLocks.get(name)
	if (!lock) {
		lock = syncStateLock()
		localSyncLocks.set(name, lock)
	}
	return lock
}

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

function recordAdopted(profileId: string): void {
	const profiles = readRegistry()
	const profile = profiles.find((entry) => entry.id === profileId)
	if (!profile) return
	profile.adopted = true
	writeRegistry(profiles)
}

function factoryResetOperation(profileId: string, fromGeneration: number) {
	const profiles = readRegistry()
	const profile = profiles.find((entry) => entry.id === profileId)
	if (!profile) throw new Error('factory reset profile is missing')
	profile.pendingFactoryReset ??= { operationId: crypto.randomUUID(), fromGeneration }
	writeRegistry(profiles)
	return profile.pendingFactoryReset
}

function clearFactoryResetOperation(profileId: string): void {
	const profiles = readRegistry()
	const profile = profiles.find((entry) => entry.id === profileId)
	if (!profile?.pendingFactoryReset) return
	delete profile.pendingFactoryReset
	writeRegistry(profiles)
}

// The old twin model's database, read once by the adoption pass and never written.
function legacyDb(profileId: string): string {
	return `frieren-fs-profile-${profileId}`
}

// A store is a whole database here, named by the store's id — so the two a profile
// holds are two names. Different from `legacyDb` on purpose: the pass copies rather
// than upgrading in place, and the swap is which name the host opens.
function storeDb(profileId: string): string {
	return (
		readRegistry().find((profile) => profile.id === profileId)?.storeDb ??
		`frieren-store-v2-${profileId}`
	)
}

const recoveryDb = (profileId: string): string => `frieren-recovery-v2-${profileId}`

function beginBootstrap(profileId: string): { oldDb: string; freshDb: string } {
	const profiles = readRegistry()
	const profile = profiles.find((entry) => entry.id === profileId)
	if (!profile) throw new Error('bootstrap profile is missing')
	const oldDb = profile.storeDb ?? `frieren-store-v2-${profileId}`
	const freshDb = `frieren-store-v2-${profileId}-bootstrap-${crypto.randomUUID()}`
	profile.pendingBootstrap = { freshDb }
	writeRegistry(profiles)
	return { oldDb, freshDb }
}

function cancelBootstrap(profileId: string): void {
	const profiles = readRegistry()
	const profile = profiles.find((entry) => entry.id === profileId)
	if (!profile?.pendingBootstrap) return
	delete profile.pendingBootstrap
	writeRegistry(profiles)
}

function finishBootstrap(profileId: string, oldDb: string, freshDb: string): LocalProfile {
	const profiles = readRegistry()
	const profile = profiles.find((entry) => entry.id === profileId)
	if (!profile || profile.pendingBootstrap?.freshDb !== freshDb)
		throw new Error('bootstrap switch is no longer current')
	profile.storeDb = freshDb
	profile.retiredStoreDbs = [...(profile.retiredStoreDbs ?? []), oldDb]
	delete profile.pendingBootstrap
	writeRegistry(profiles)
	return profile
}

async function recoverProfileSwitch(profileId: string): Promise<void> {
	await profileSyncStateLock(profileId)(async () => {
		const profiles = readRegistry()
		const profile = profiles.find((entry) => entry.id === profileId)
		if (!profile) return
		if (profile.pendingBootstrap) {
			await deleteIdb(profile.pendingBootstrap.freshDb)
			delete profile.pendingBootstrap
		}
		for (const retired of profile.retiredStoreDbs ?? []) await deleteIdb(retired)
		delete profile.retiredStoreDbs
		writeRegistry(profiles)
	})
}

function privateDb(profileId: string): string {
	return `frieren-store-v2-${profileId}-${PRIVATE_MOUNT}`
}

type Active = {
	profileId: string
	remoteUserId?: string
	store: string
	replica: string
	/** The synced tree. What the volume reads and what a peer is offered. */
	local: Store
	/** This browser's own data, joined at `/private`: credentials, the app cache. */
	private: Store
	/** Stable identity and relationship cursors in the private mount. */
	syncState: PrivateSyncState
	/**
	 * The volume this profile answers on before — and beside — any sync. It mints under
	 * the profile's replica id, so a write made while auth is still resolving is still
	 * this replica's to push.
	 */
	plain: Volume
	sync: SyncVolume | null
	volume: ProfileVolume
	status: SyncStatus
	unsubscribeSyncStatus?: () => void
	reconnect?: () => void
	teardown: () => void
}

function activeCursor(entry: Active, name: 'pull' | 'push'): CursorSlot {
	const cursor = entry.syncState.cursor(name)
	const current = (): void => {
		if (storeDb(entry.profileId) !== entry.store) throw new BootstrapRequiredError()
	}
	return {
		load: async () => {
			current()
			return cursor.load()
		},
		save: async (next) => {
			current()
			await cursor.save(next)
		}
	}
}

function fenceCommits(store: Store, profileId: string, name: string): Store {
	const lock = profileSyncStateLock(profileId)
	return {
		...store,
		commit: (writes, guards) =>
			lock(async () => {
				if (storeDb(profileId) !== name) throw new BootstrapRequiredError()
				await store.commit(writes, guards)
			})
	}
}

let active: Active | null = null
const statusListeners = new Set<() => void>()

/**
 * Every switch of the active profile runs alone.
 *
 * All of them are the same two steps — tear the current replica down, stand the
 * next one up — and each step spans awaits, so two of them interleaved stand up
 * two live replicas of one database: two store connections and two cross-tab
 * channels, of which only the last is `active` and therefore the only one anything
 * ever closes. The window is not hypothetical: React invokes a mount effect twice,
 * so boot asks for a profile twice in one tick, and an auth resolve can land on top
 * of that.
 *
 * A queue rather than "one at a time, drop the rest": a caller asking for the local
 * profile while an account is still being attached wants its answer AFTER that
 * attach, not the account's volume.
 */
let switching: Promise<unknown> = Promise.resolve()
function alone<T>(body: () => Promise<T>): Promise<T> {
	// What the next switch waits on is this one having FINISHED, not having worked.
	const next = switching.then(async () => {
		await ownBrowser()
		return body()
	})
	switching = next.catch(() => undefined)
	return next
}

function emitStatus(): void {
	for (const fn of statusListeners) fn()
}

function setActiveStatus(entry: Active, status: SyncStatus): void {
	if (entry.status === status) return
	entry.status = status
	emitStatus()
}

function createProfileVolume(plain: Volume, of: () => Active): ProfileVolume {
	const sync = () => of().sync
	return {
		...plain,
		// The synced volume reads through `hydratingBlobs`, so a row this replica holds
		// only as a stub still reads: the bytes are fetched from the peer on demand.
		// Everything else is the same tree over the same store, so it stays on `plain`.
		readFile: (path) => sync()?.readFile(path) ?? plain.readFile(path),
		flush: () => sync()?.flush() ?? Promise.resolve(),
		pause: () => sync()?.pause(),
		resume: () => sync()?.resume(),
		// Through `stopSync`, because a destroyed loop is TERMINAL — `synced.destroy()`
		// stands its timer down for good and nothing resumes it. A reference to one is a
		// profile that reads as syncing and never will again: `flush` and `status` answer
		// for a loop that stopped, and `startSync` leaves a loop that is already there
		// alone. Dropping the reference is what makes this recoverable — the profile falls
		// back to local-only, and the next attach builds a loop.
		destroy: () => stopSync(of()),
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

const memoryCursor = (): CursorSlot & { value(): Cursor | undefined } => {
	let cursor: Cursor | undefined
	return {
		load: async () => cursor,
		save: async (next) => {
			cursor = next
		},
		value: () => cursor
	}
}

async function preserveUnacknowledged(
	local: Store,
	recovery: Store,
	from: Cursor | undefined,
	replica: string
): Promise<void> {
	const verified = verifiedBlobs(recovery.blobs)
	const preserve = async (start: Cursor | undefined): Promise<void> => {
		let cursor = start
		for (;;) {
			const page = await local.since(cursor)
			const mine = page.nodes.filter((row) => authorOf(row.version) === replica)
			for (const row of mine) {
				if (row.deleted || row.content === undefined) continue
				const data = await local.blobs.get(row.content)
				if (data === null) throw new Error(`cannot preserve unacknowledged blob ${row.content}`)
				await verified.put(row.content, data)
			}
			await recovery.commit(mine)
			if (page.next === undefined || page.nodes.length === 0) return
			cursor = page.next
		}
	}
	try {
		await preserve(from)
	} catch (error) {
		if (from === undefined || !(error instanceof ForeignCursorError)) throw error
		await preserve(undefined)
	}
}

async function replaceStaleProfile(
	entry: Active,
	peer: Store,
	push: CursorSlot,
	lock: SyncStateLock
): Promise<Active> {
	const nextPull = memoryCursor()
	// Keep `pendingBootstrap` owned until the same tab publishes the finished switch.
	// A second tab waits; if this one dies, the browser releases the lock and recovery
	// can then delete the abandoned database.
	const profile = await lock(async () => {
		const pending = beginBootstrap(entry.profileId)
		const recovery = idbStore(recoveryDb(entry.profileId))
		const fresh = idbStore(pending.freshDb)
		try {
			await preserveUnacknowledged(entry.local, recovery, await push.load(), entry.replica)
			await bootstrap(fresh, peer, nextPull, { lazyContent: true })
		} catch (error) {
			await Promise.allSettled([fresh.close?.(), recovery.close?.()])
			await deleteIdb(pending.freshDb)
			cancelBootstrap(entry.profileId)
			throw error
		}
		await Promise.all([fresh.close?.(), recovery.close?.()])
		await release({ flush: false })
		return finishBootstrap(entry.profileId, pending.oldDb, pending.freshDb)
	})
	const next = await setActive(profile)
	await lock(async () => {
		await next.syncState.cursor('push').save(undefined)
		await next.syncState.cursor('pull').save(nextPull.value())
	})
	return next
}

async function startSync(entry: Active, getToken: GetToken): Promise<Active> {
	// This profile is already syncing, so there is nothing to start. The auth effect
	// re-runs whenever Clerk hands out a new token getter, and each getter is a
	// closure over the LIVE session — the running loop's is as current as this one.
	// Building a second loop over the same store is not free and not idempotent: a
	// `destroy` cannot take back the cycle the old loop already has in flight, so the
	// two of them push the same rows at the same time.
	if (storeDb(entry.profileId) !== entry.store) {
		location.reload()
		return entry
	}
	if (entry.sync) return entry
	entry.reconnect = () => recoverStale(entry, getToken)
	entry.unsubscribeSyncStatus?.()
	setActiveStatus(entry, 'connecting')
	const pull = activeCursor(entry, 'pull')
	const push = activeCursor(entry, 'push')
	const lock = profileSyncStateLock(entry.profileId)
	const peer = remoteStore(getToken)
	const remote = remoteStore(getToken, (body) =>
		lock(async () => {
			if (storeDb(entry.profileId) !== entry.store) throw new BootstrapRequiredError()
			return body()
		})
	)
	try {
		const cursor = await pull.load()
		if (cursor === undefined) throw new BootstrapRequiredError()
		await peer.since(cursor)
	} catch (error) {
		if (error instanceof BootstrapRequiredError) {
			if (storeDb(entry.profileId) !== entry.store) {
				location.reload()
				return entry
			}
			const replacement = await replaceStaleProfile(entry, peer, push, lock)
			return startSync(replacement, getToken)
		}
		// Local-first keeps serving its existing replica while an offline peer retries.
	}
	const syncVolume = await synced({
		local: entry.local,
		remote,
		replica: entry.replica,
		pull,
		push,
		lock,
		onBootstrapRequired: entry.reconnect,
		// A discard that stopped half-done is finished before the first cycle, which is
		// the only way it can be: `synced` starts its loop before it returns, so
		// nothing the app could call afterwards is early enough.
		discard: entry.syncState.discard,
		bindings: new Map([[ROOT, new Map([[PRIVATE_MOUNT, entry.private]])]]),
		lazyContent: true,
		localFirst: true
	})
	if (active !== entry) {
		syncVolume.destroy()
		return entry
	}
	entry.sync = syncVolume
	setActiveStatus(entry, syncVolume.status())
	entry.unsubscribeSyncStatus = syncVolume.onStatusChange((next) => {
		if (active === entry) setActiveStatus(entry, next)
	})
	return entry
}

const recovering = new WeakSet<Active>()
function recoverStale(entry: Active, getToken: GetToken): void {
	if (recovering.has(entry)) return
	recovering.add(entry)
	void (async () => {
		await Promise.resolve()
		if (active !== entry) return
		const stale = entry.sync
		stopSync(entry)
		await stale?.drain()
		if (active === entry) await startSync(entry, getToken)
	})()
		.catch((error) => {
			if (active === entry) setActiveStatus(entry, 'error')
			console.error(error)
		})
		.finally(() => recovering.delete(entry))
}

/** The server's own lineage, off the one non-seam route that reports it. */
async function readGeneration(
	client: FsClient
): Promise<{ generation: number; lineageId?: string }> {
	const res = await client.index.$get()
	if (!res.ok) throw new Error(`the server would not report its generation: ${res.status}`)
	const handshake = await res.json()
	return { generation: handshake.generation ?? 1, lineageId: handshake.lineageId }
}

async function setActive(profile: LocalProfile): Promise<Active> {
	await recoverProfileSwitch(profile.id)
	// The channel is the DATABASE's name in both cases: what a wake has to be scoped to
	// is the store it is telling other tabs about.
	const name = storeDb(profile.id)
	const privateName = privateDb(profile.id)
	const openedLocal = sharedStore(idbStore(name), name)
	const privateStore = sharedStore(idbStore(privateName), privateName)
	// The name is claimed before anything reads the tree: the row is derived from its
	// position, so every replica writes a byte-identical one and none of them ever sends
	// it — the whole of how this browser reserves `/private` with no coordination.
	await announceMount(openedLocal, ROOT, PRIVATE_MOUNT)
	// Held against every other tab, and the marker READ inside it: a second tab that
	// checked `adopted` before this one recorded it would copy the old tree a second time,
	// over rows this tab's volume had already pulled or written (see `adoptOnce`). The
	// registry is re-read rather than trusting the `profile` this was called with, which is
	// a snapshot taken before the wait.
	await adoptOnce(name, async () => {
		if (readRegistry().find((entry) => entry.id === profile.id)?.adopted) return
		// `/private` was a path the old engine filtered; here its subtree lands in the
		// store bound at that name, hanging off that store's own root.
		await migrateIdb(legacyDb(profile.id), openedLocal, new Map([[PRIVATE_MOUNT, privateStore]]))
		recordAdopted(profile.id)
	})
	const local = fenceCommits(openedLocal, profile.id, name)
	const bindings = new Map([[ROOT, new Map([[PRIVATE_MOUNT, privateStore]])]])
	const syncState = privateSyncState(
		volume(local, { bindings }),
		undefined,
		legacySyncState(profile.id)
	)
	const replica = await syncState.peerId()

	let entry: Active
	const plain = volume(local, {
		bindings,
		mintVersion: versions(replica)
	})
	const managed = createProfileVolume(plain, () => entry)

	// Online-aware sync: stop pushing when the network drops, resume when it
	// returns, and flush pending writes to the backend before the tab goes away.
	const onOnline = () => {
		if (active !== entry) return
		if (entry.sync) entry.sync.resume()
		else entry.reconnect?.()
	}
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
		profileId: profile.id,
		remoteUserId: profile.remoteUserId,
		store: name,
		replica,
		local,
		private: privateStore,
		syncState,
		plain,
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

async function openProfileVolume(profile: LocalProfile): Promise<ProfileVolume> {
	return (await setActive(profile)).volume
}

// Open the current browser profile's IDB volume. Remote profiles boot from their
// local replica immediately; auth later starts sync or switches after sign-out.
export function openProfile(): Promise<ProfileVolume> {
	// The check is INSIDE the queue: a caller that read `active` while a switch was
	// still running would either build a second replica of the same profile or hand
	// back the volume that switch is about to release.
	return alone(async () => active?.volume ?? (await openProfileVolume(currentProfile())))
}

// A local profile can start the runtime before Clerk resolves. An account profile
// waits for attachRemoteUser() to start sync, so runtime bootstrap can flush it.
export async function openBootProfile(): Promise<string | null> {
	await openProfile()
	return activeProfileHasRemoteUser() ? null : activeProfileId()
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
export function attachRemoteUser(userId: string, getToken: GetToken): Promise<ProfileVolume> {
	return alone(async () => {
		const cur = active
		if (cur?.remoteUserId === userId) {
			return (await startSync(cur, getToken)).volume
		}

		// Switch to (or create) the profile that owns this user.
		await release({ flush: false })
		const entry = await setActive(profileForUser(userId))
		return (await startSync(entry, getToken)).volume
	})
}

// Sign-out switches back to the browser-local workspace. Account data stays on
// disk for that account profile, but it is no longer the active desktop.
export function switchToLocalProfile(): Promise<ProfileVolume> {
	return alone(async () => {
		if (active && !activeProfileHasRemoteUser()) {
			stopSync(active)
			return active.volume
		}
		await release({ flush: false })
		return openProfileVolume(localProfile())
	})
}

// Stop syncing and release the active replica WITHOUT deleting it. Called on
// user switch — local profile data is preserved on this browser so the user can
// return to it. Per-profile DB names already prevent cross-user leakage, so
// there is nothing to delete for safety.
export function releaseFsVolume(options: { flush?: boolean } = {}): Promise<void> {
	return alone(() => release(options))
}

// The release itself, for the switches that hold the queue already: a switch that
// waited on itself here would never run at all.
async function release(options: { flush?: boolean } = {}): Promise<void> {
	const prev = active
	if (!prev) return
	active = null
	emitStatus()
	prev.teardown()
	if (options.flush ?? true) await prev.sync?.flush().catch(() => {})
	else prev.sync?.pause()
	prev.sync?.destroy()
	// Whoever CONSTRUCTED a store closes it, and this is that: the connections are
	// what a later delete of these databases would otherwise block on.
	await prev.local.close?.()
	await prev.private.close?.()
}

// Explicit "forget this browser": release and permanently delete the active
// profile's local replica and registry entry. Sign-out alone never does this.
export function forgetActiveProfile(): Promise<void> {
	return alone(async () => {
		const prev = active
		if (!prev) return
		const { profileId } = prev
		await release({ flush: false })
		await forgetSlots(profileId)
		await deleteProfileDbs(profileId)
		forgetProfileEntry(profileId)
	})
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
const RESERVED_TOP_LEVEL = new Set(['.state', 'applications', PRIVATE_MOUNT, 'state', 'system'])
// Copied subtree: user data + personalized identity only — never app bundles or per-app
// UI state. `/private` needs no entry: it is a MOUNT, and `scan` stops at one, so the
// credentials and the app cache behind it are not reachable from this walk at all.
const MIGRATE_SKIP = ['/.state', '/applications', '/state']
// The two identity files — the only paths a migration is allowed to overwrite (with the
// user's personalized version). Nothing writes them until someone personalizes, so on the
// destination they are usually absent rather than a `seeded: true` default; both read as
// "not personalized" below, which is what makes either safe to replace.
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

function openLocalSource(): { volume: Volume; destroy: () => Promise<void> } {
	// The synced tree alone, with no binding: the walk below never leaves it, and the
	// anonymous profile's `/private` is not this account's to copy.
	const store = idbStore(storeDb(anonymousProfileId()))
	return { volume: volume(store), destroy: async () => store.close?.() }
}

// A soul/profile file is "personalized" once the user writes one of their own. An absent
// file is the built-in identity (agent-defaults), and so is one still carrying `seeded: true`
// in its frontmatter — a file a host wrote back when defaults were seeded, or one synced from
// such a device. Neither is the user's.
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
// DO). The loop cycles syncing→synced on success and syncing→error on failure
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
		await source.destroy()
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
			await source.destroy()
			migrating = null
		}
	})()
	return migrating
}

// scan is BFS, so it visits a directory before its contents — mkdir the dir, then
// writeFile children into it. Per-path conflict policy: the offer is non-blocking, so
// between the freshness check and confirmation the account can gain content (the user
// makes a note; another device syncs one in). So NEVER clobber an existing destination
// path — the one exception is replacing an identity file the account never personalized
// with the user's own soul/profile, which is the whole point of migrating identity.
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

// True only for an identity file the account never personalized and the local
// profile did — the sole allowed overwrite.
async function replacesSeededIdentity(src: Volume, dst: Volume, path: string): Promise<boolean> {
	if (!IDENTITY_PATHS.has(path)) return false
	return (await isPersonalized(src, path)) && !(await isPersonalized(dst, path))
}

/** Both databases a profile holds, and the old one the pass copied out of. */
async function deleteProfileDbs(profileId: string): Promise<void> {
	const profile = readRegistry().find((entry) => entry.id === profileId)
	const names = new Set([
		storeDb(profileId),
		`frieren-store-${profileId}`,
		privateDb(profileId),
		legacyDb(profileId),
		recoveryDb(profileId),
		...(profile?.retiredStoreDbs ?? []),
		...(profile?.pendingBootstrap ? [profile.pendingBootstrap.freshDb] : [])
	])
	for (const name of names) await deleteIdb(name)
}

function deleteIdb(name: string): Promise<void> {
	return new Promise((resolve) => {
		const req = indexedDB.deleteDatabase(name)
		// Resolve only once the delete TRULY completes. Resolving on `onblocked` (the
		// previous behaviour) let the caller's `location.reload()` race ahead and abort
		// the still-pending delete, so the local replica survived a factory reset — its
		// stale sync state then stalled the next bootstrap. `releaseFsVolume`'s
		// `close()` already closed the connection, so a transient block clears itself.
		req.onsuccess = req.onerror = () => resolve()
		req.onblocked = () =>
			console.warn(`[factoryReset] IndexedDB "${name}" delete blocked — close other tabs`)
	})
}

// ── Server-coordinated volume reset ──────────────────────────────────────────
// Surfaced in the sync-status menu (DesktopShell). "Take theirs" and "take mine"
// are intents on the synced volume — the loop that carries them out lives in
// `synced`. Only "factory reset" is app-level: it wipes the server AND nukes
// local IDB, which no library-level reset can do.

// "Take theirs" — discard this device's local replica and re-pull the server's
// volume. Purely client-side. Synced profiles only.
export async function resetTakeTheirs(): Promise<void> {
	const sync = active?.sync
	if (!sync) throw new Error('“take theirs” requires a synced profile')
	await sync.takeTheirs()
}

// "Take mine" — make this device's volume the new server baseline; every other
// device converges to it over ordinary sync. The reset is a small atomic server
// op (empty + bump); the republish then rides the normal resilient loop — so a
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
export function factoryReset(getToken: GetToken): Promise<void> {
	return alone(async () => {
		const prev = active
		if (!prev) return
		let operation: LocalProfile['pendingFactoryReset']
		if (prev.remoteUserId) {
			// `wipe` is not part of the sync loop's reset (it discards content too), so it
			// goes over the same typed /fs/reset route directly. The epoch is READ from the
			// server, not remembered: nothing in the seam carries one. Persist the request
			// outside IDB first — a 503 is ambiguous, and retrying must confirm the same
			// operation rather than race it with a new id at the old generation.
			const client = createFsClient(getToken)
			const from = await readGeneration(client)
			operation = factoryResetOperation(prev.profileId, from.generation)
			const res = await client.reset.$post({
				json: {
					mode: 'wipe',
					fromGeneration: operation.fromGeneration,
					operationId: operation.operationId,
					...(from.lineageId === undefined ? {} : { lineageId: from.lineageId })
				}
			})
			if (!res.ok) {
				// A conflict is definitive: this operation did not commit and cannot be
				// replayed. Transport/5xx failures remain ambiguous and retain the marker.
				if (res.status === 409) clearFactoryResetOperation(prev.profileId)
				throw new Error(`factory reset failed: ${res.status}`)
			}
		}
		const { profileId } = prev
		await release({ flush: false })
		await forgetSlots(profileId)
		await deleteProfileDbs(profileId)
		if (operation) clearFactoryResetOperation(profileId)
		location.reload()
	})
}
