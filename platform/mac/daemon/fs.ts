import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { type FileHandle, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { announceMount, type Bindings, type Volume, volume } from '@justfiles/fs'
import { fsStore } from '@justfiles/fs/fs'
import { httpStore } from '@justfiles/fs/http'
import { ROOT, type Store } from '@justfiles/fs/store'
import { bootstrap, type CursorSlot, type SyncStatus, synced, versions } from '@justfiles/fs/synced'
import { privateSyncState } from '@justfiles/fs/syncState'
import { SHIPPED } from './resources'

const supportDir = (): string =>
	process.env.FRIEREN_SUPPORT_DIR ??
	join(homedir(), 'Library', 'Application Support', 'Just Computer')
const runtimePath = (): string => join(supportDir(), 'runtime.json')
const lockPath = (): string => join(supportDir(), 'daemon.lock')
const PRIVATE = 'private'
const VOLUME = 'volume-v3'
const SYNC_STATE = 'sync.json'
const OWNER_STATE = 'owner.json'
const PROD_ORIGIN = 'https://justcomputer.app'
const DEV_ORIGIN = 'https://staging.justcomputer.app'
export const platformOrigin = (): string =>
	process.env.KODAMA_STORE_ORIGIN ?? (SHIPPED ? PROD_ORIGIN : DEV_ORIGIN)
const SHUTDOWN_FLUSH_MS = 5_000

// macOS O_EXLOCK. Node and Bun pass numeric open flags through but do not publish this constant.
// The kernel releases the lock when this process closes the handle or dies.
const O_EXLOCK = 0x20

export interface Runtime {
	port: number
	token: string
	pid: number
}

type StorageStatus = SyncStatus | 'local-only'
type Send = (url: string, init?: RequestInit) => Promise<Response>
type SyncVolume = Awaited<ReturnType<typeof synced>>

interface SyncState {
	replica: string
	pull?: string
	push?: string
	discard: boolean
	ownerId: string | null
}

interface OwnerState {
	ownerId: string | null
	store?: string
	pending?: { store: string; pull: string }
}

export interface NativeStorageOptions {
	supportDir: string
	ownerId?: string | null
	getToken?: () => Promise<string | null>
	origin?: string
	fetch?: Send
	interval?: number
	/** Restart the daemon after a freshly bootstrapped store is ready to become active. */
	restart?: () => void
}

export interface NativeStorage {
	volume: Volume
	ownerId: string | null
	/** True after the first remote cycle, or at once for local-only; false if sync stops first. */
	firstSync: Promise<boolean>
	status(): StorageStatus
	flush(timeoutMs?: number): Promise<boolean>
	stopSync(): Promise<void>
	close(): Promise<void>
	remove(): Promise<void>
}

export class OwnerChangedError extends Error {
	constructor() {
		super('the authenticated owner changed')
	}
}

/** A Volume call can span several Store turns. Keep the stores open until the whole call ends. */
function trackVolume(source: Volume): { volume: Volume; drain(): Promise<void> } {
	const active = new Set<Promise<unknown>>()
	let closing = false
	const track = (source: Volume): Volume =>
		new Proxy(source, {
			get(target, key, receiver) {
				const value = Reflect.get(target, key, receiver)
				if (typeof value !== 'function') return value
				if (key === 'restrict')
					return (...args: unknown[]) => track(Reflect.apply(value, target, args))
				return (...args: unknown[]) => {
					if (closing) return Promise.reject(new Error('storage is closing'))
					const run = Reflect.apply(value, target, args) as Promise<unknown>
					active.add(run)
					const done = (): void => void active.delete(run)
					void run.then(done, done)
					return run
				}
			}
		})
	return {
		volume: track(source),
		async drain() {
			closing = true
			await Promise.allSettled(active)
		}
	}
}

export async function createNativeStorage(options: NativeStorageOptions): Promise<NativeStorage> {
	const root = join(options.supportDir, VOLUME)
	const statePath = join(root, SYNC_STATE)
	const ownerPath = join(root, OWNER_STATE)
	await mkdir(root, { recursive: true })

	const savedState = await readSyncState(statePath)
	const ownerState = await readOwner(ownerPath)
	const savedOwner = ownerState?.ownerId ?? savedState?.ownerId
	const requestedOwner = options.ownerId
	if (savedOwner !== undefined && requestedOwner && savedOwner !== requestedOwner) {
		await rm(root, { recursive: true, force: true })
		throw new OwnerChangedError()
	}
	// A signed-out process still owns its existing local replica. Keep sync wired to
	// that owner with a dynamic token source; it stays offline until the same owner
	// signs in again. Only a different signed-in owner replaces the volume.
	const ownerId = savedOwner ?? requestedOwner ?? null
	const mainName = ownerState?.pending?.store ?? ownerState?.store ?? 'main'

	const mainRoot = join(root, mainName)
	const privateRoot = join(root, PRIVATE)
	await Promise.all([mkdir(mainRoot, { recursive: true }), mkdir(privateRoot, { recursive: true })])

	const privateStore = fsStore(privateRoot)
	const saved = privateSyncState(volume(privateStore), '/state', {
		peerId: savedState?.replica ?? randomUUID(),
		relationship: {
			pull: savedState?.pull,
			push: savedState?.push,
			discard: savedState?.discard
		}
	})
	const replica = await saved.peerId()
	if (ownerState?.pending) {
		await saved.cursor('push').save(undefined)
		await saved.cursor('pull').save(ownerState.pending.pull)
	}
	await atomicWrite(ownerPath, { ownerId, ...(mainName === 'main' ? {} : { store: mainName }) })
	if (savedState) await rm(statePath, { force: true })
	const mainStore = fsStore(mainRoot, {
		mounts: [PRIVATE],
		mintVersion: versions(replica)
	})
	let sync: SyncVolume | undefined
	let abortRemote: (() => void) | undefined
	let offStatus: (() => void) | undefined
	let finishFirstSync: ((synced: boolean) => void) | undefined
	let offFirstSync: (() => void) | undefined
	let replacement: Promise<void> | undefined

	try {
		await announceMount(mainStore, ROOT, PRIVATE)
		const bindings: Bindings = new Map([[ROOT, new Map([[PRIVATE, privateStore]])]])
		let source: Volume
		if (ownerId === null) {
			source = volume(mainStore, {
				bindings,
				mintVersion: versions(replica)
			})
		} else {
			if (!options.getToken) throw new Error('authenticated storage needs a token source')
			const remote = remoteStore(options.getToken, options.origin, options.fetch)
			abortRemote = remote.abort
			const pull = saved.cursor('pull')
			const replace = (): void => {
				sync?.pause()
				replacement ??= replaceStore(root, ownerPath, ownerId, remote.store)
					.then(() => options.restart?.())
					.catch((error) => {
						replacement = undefined
						console.error('sync: store replacement failed', error)
						sync?.resume()
					})
			}
			sync = await synced({
				local: mainStore,
				remote: remote.store,
				replica,
				pull,
				push: saved.cursor('push'),
				discard: saved.discard,
				bindings,
				lazyContent: true,
				localFirst: true,
				onBootstrapRequired: replace,
				interval: options.interval
			})
			console.info(`sync: ${sync.status()}`)
			offStatus = sync.onStatusChange((status) => console.info(`sync: ${status}`))
			source = sync
		}
		const firstSync = sync
			? new Promise<boolean>((resolve) => {
					finishFirstSync = (synced) => {
						offFirstSync?.()
						offFirstSync = undefined
						finishFirstSync = undefined
						resolve(synced)
					}
					if (sync?.status() === 'synced') finishFirstSync(true)
					else
						offFirstSync = sync?.onStatusChange((status) => {
							if (status === 'synced') finishFirstSync?.(true)
						})
				})
			: Promise.resolve(true)

		const tracked = trackVolume(source)
		let stopOnce: Promise<void> | undefined
		let closeOnce: Promise<void> | undefined
		let removeOnce: Promise<void> | undefined

		const stopSync = (): Promise<void> => {
			if (!sync) return Promise.resolve()
			if (!stopOnce) {
				offStatus?.()
				finishFirstSync?.(false)
				sync.pause()
				sync.destroy()
				abortRemote?.()
				stopOnce = sync.drain()
			}
			return stopOnce
		}

		const close = (): Promise<void> => {
			closeOnce ??= (async () => {
				await stopSync()
				await replacement
				await tracked.drain()
				await Promise.all([closeStore(mainStore), closeStore(privateStore)])
			})()
			return closeOnce
		}

		return {
			volume: tracked.volume,
			ownerId,
			firstSync,
			status: () => sync?.status() ?? 'local-only',
			async flush(timeoutMs = SHUTDOWN_FLUSH_MS) {
				if (!sync) return true
				let timer: ReturnType<typeof setTimeout> | undefined
				const timedOut = new Promise<false>((resolve) => {
					timer = setTimeout(() => resolve(false), timeoutMs)
				})
				const finished = sync.flush().then(() => sync?.status() === 'synced')
				const ok = await Promise.race([finished, timedOut])
				if (timer) clearTimeout(timer)
				return ok
			},
			stopSync,
			close,
			remove() {
				removeOnce ??= close().then(() => rm(root, { recursive: true, force: true }))
				return removeOnce
			}
		}
	} catch (error) {
		offStatus?.()
		sync?.destroy()
		abortRemote?.()
		await sync?.drain()
		await Promise.allSettled([closeStore(mainStore), closeStore(privateStore)])
		throw error
	}
}

async function replaceStore(
	root: string,
	ownerPath: string,
	ownerId: string,
	remote: Store
): Promise<void> {
	const name = `main-${randomUUID()}`
	const path = join(root, name)
	await mkdir(path, { recursive: true })
	const fresh = fsStore(path)
	const pull = memoryCursor()
	try {
		await bootstrap(fresh, remote, pull, { lazyContent: true })
	} catch (error) {
		await closeStore(fresh)
		await rm(path, { recursive: true, force: true })
		throw error
	}
	await closeStore(fresh)
	const cursor = pull.value()
	if (cursor === undefined) throw new Error('bootstrap did not produce a cursor')
	await atomicWrite(ownerPath, { ownerId, pending: { store: name, pull: cursor } })
}

function memoryCursor(): CursorSlot & { value(): string | undefined } {
	let cursor: string | undefined
	return {
		load: async () => cursor,
		save: async (next) => {
			cursor = next
		},
		value: () => cursor
	}
}

function remoteStore(
	getToken: () => Promise<string | null>,
	origin = platformOrigin(),
	send: Send = fetch
): { store: Store; abort(): void } {
	const controller = new AbortController()
	return {
		store: httpStore(new URL('/store', origin).toString(), {
			fetch: async (url, init) => {
				const headers = new Headers(init?.headers)
				headers.set('authorization', `Bearer ${(await getToken()) ?? ''}`)
				return send(url, { ...init, headers, signal: controller.signal })
			}
		}),
		abort: () => controller.abort()
	}
}

async function readSyncState(path: string): Promise<SyncState | null> {
	let raw: string
	try {
		raw = await readFile(path, 'utf8')
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
		throw error
	}
	const value = JSON.parse(raw) as Partial<SyncState>
	if (
		typeof value.replica !== 'string' ||
		(value.pull !== undefined && typeof value.pull !== 'string') ||
		(value.push !== undefined && typeof value.push !== 'string') ||
		typeof value.discard !== 'boolean' ||
		(value.ownerId !== null && typeof value.ownerId !== 'string')
	) {
		throw new Error('invalid native sync state')
	}
	return value as SyncState
}

async function readOwner(path: string): Promise<OwnerState | undefined> {
	try {
		const value = JSON.parse(await readFile(path, 'utf8')) as Partial<OwnerState>
		if (value.ownerId !== null && typeof value.ownerId !== 'string')
			throw new Error('invalid native owner state')
		if (value.store !== undefined && !storeName(value.store))
			throw new Error('invalid native owner state')
		if (
			value.pending !== undefined &&
			(!storeName(value.pending.store) || typeof value.pending.pull !== 'string')
		)
			throw new Error('invalid native owner state')
		return value as OwnerState
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
		throw error
	}
}

const storeName = (value: unknown): value is string =>
	value === 'main' || (typeof value === 'string' && /^main-[0-9a-f-]{36}$/.test(value))

async function atomicWrite(path: string, state: unknown): Promise<void> {
	const temp = `${path}.tmp`
	await writeFile(temp, JSON.stringify(state), { mode: 0o600 })
	await rename(temp, path)
}

const closeStore = (store: Store): Promise<void> => store.close?.() ?? Promise.resolve()

let storageOnce: Promise<NativeStorage> | undefined

export async function startStorage(
	options: Omit<NativeStorageOptions, 'supportDir'>
): Promise<NativeStorage> {
	if (storageOnce) throw new Error('storage already started')
	const storage = await createNativeStorage({ ...options, supportDir: supportDir() })
	storageOnce = Promise.resolve(storage)
	return storage
}

export function getStorage(): Promise<NativeStorage> {
	storageOnce ??= createNativeStorage({ supportDir: supportDir(), ownerId: null })
	return storageOnce
}

export function getVolume(): Promise<Volume> {
	return getStorage().then((owner) => owner.volume)
}

export async function closeStorage(): Promise<void> {
	const owner = await storageOnce
	await owner?.close()
}

export async function acquireDaemonLock(): Promise<{ release(): Promise<void> } | null> {
	if (process.platform !== 'darwin') throw new Error('daemon lock requires macOS')
	await mkdir(supportDir(), { recursive: true })

	let handle: FileHandle
	try {
		handle = await open(
			lockPath(),
			constants.O_CREAT | constants.O_RDWR | constants.O_NONBLOCK | O_EXLOCK,
			0o600
		)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EAGAIN') return null
		throw error
	}

	let released = false
	return {
		async release() {
			if (released) return
			released = true
			await handle.close()
		}
	}
}

export async function writeRuntime(runtime: Runtime): Promise<void> {
	await mkdir(supportDir(), { recursive: true })
	await Bun.write(runtimePath(), JSON.stringify(runtime))
}

export async function clearRuntime(): Promise<void> {
	const file = Bun.file(runtimePath())
	if (await file.exists()) await file.delete()
}
