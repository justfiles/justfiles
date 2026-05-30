import { apiStorage, createFsClient as createCoreFsClient, type FsClient } from '@justfiles/core'
import { synced, type Volume } from '@justfiles/fs'
import { idbStorage } from '@justfiles/fs/storage/idb'

export type { FsClient, Volume }

export type GetToken = () => Promise<string | null>

// A synced local volume: a browser-local replica that reconciles with the
// backend. Adds the sync lifecycle on top of the plain volume surface.
export type SyncedVolume = Volume & {
	flush(): Promise<void>
	pause(): void
	resume(): void
	destroy(): void
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

function dbName(userId: string): string {
	return `frieren-fs-${userId}`
}

type Active = {
	userId: string
	local: ReturnType<typeof idbStorage>
	volume: Promise<SyncedVolume>
	teardown: () => void
}

let active: Active | null = null

// Singleton, per-user synced volume. The app shell, OS provider, and onboarding
// all read/write one local replica, so there is exactly one sync loop per user.
// A different userId tears the previous replica down first so it can never leak.
export function getFsVolume(userId: string, getToken: GetToken): Promise<SyncedVolume> {
	if (active && active.userId === userId) return active.volume
	void destroyFsVolume({ flush: false })

	const local = idbStorage(dbName(userId))
	const volume = (async () => {
		const remote = await apiStorage(createFsClient(getToken))
		return synced({ local, remote, lazyContent: true })
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
		userId,
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

// Stop syncing and delete the local replica. Called on sign-out / user switch so
// the next user can never read the previous user's cached volume. Explicit user
// switches flush first; implicit auth teardown drops local state without using a
// possibly-new user's token.
export async function destroyFsVolume(options: { flush?: boolean } = {}): Promise<void> {
	const prev = active
	if (!prev) return
	active = null
	prev.teardown()
	const vol = await prev.volume.catch(() => null)
	if (options.flush ?? true) await vol?.flush().catch(() => {})
	else vol?.pause()
	vol?.destroy()
	prev.local.destroy()
	await deleteIdb(dbName(prev.userId))
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
