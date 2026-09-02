import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { type FileHandle, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { announceMount, type Bindings, type Volume, volume } from '@justfiles/fs'
import { fsStore } from '@justfiles/fs/fs'
import { encodeNode } from '@justfiles/fs/http'
import { BootstrapRequiredError } from '@justfiles/fs/lease'
import { type LeasedRemote, leasedHttpStore } from '@justfiles/fs/leased-http'
import { ROOT, type Store, sha256Hex } from '@justfiles/fs/store'
import {
	authorOf,
	bootstrap,
	type CursorSlot,
	type DiscardSlot,
	type SyncStatus,
	synced,
	versions
} from '@justfiles/fs/synced'
import { SHIPPED } from './resources'

const supportDir = (): string =>
	process.env.FRIEREN_SUPPORT_DIR ??
	join(homedir(), 'Library', 'Application Support', 'Just Computer')
const runtimePath = (): string => join(supportDir(), 'runtime.json')
const lockPath = (): string => join(supportDir(), 'daemon.lock')
const PRIVATE = 'private'
const VOLUME = 'volume-v2'
const SYNC_STATE = 'sync.json'
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
	storeId?: string
}

export interface NativeStorageOptions {
	supportDir: string
	ownerId?: string | null
	getToken?: () => Promise<string | null>
	origin?: string
	fetch?: Send
	interval?: number
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
	const volume = new Proxy(source, {
		get(target, key, receiver) {
			const value = Reflect.get(target, key, receiver)
			if (typeof value !== 'function') return value
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
		volume,
		async drain() {
			closing = true
			await Promise.allSettled(active)
		}
	}
}

type StoreListener = Parameters<NonNullable<Store['subscribe']>>[0]

function switchableStore(initial: Store) {
	let current = initial
	const listeners = new Map<StoreListener, () => void>()
	const store: Store = {
		get: (id) => current.get(id),
		child: (parent, name) => current.child(parent, name),
		children: (parent, cursor) => current.children(parent, cursor),
		since: (cursor) => current.since(cursor),
		commit: (writes, guards) => current.commit(writes, guards),
		blobs: {
			has: (hash) => current.blobs.has(hash),
			get: (hash) => current.blobs.get(hash),
			put: (hash, data) => current.blobs.put(hash, data)
		},
		subscribe(listener) {
			listeners.set(listener, current.subscribe?.(listener) ?? (() => {}))
			return () => {
				listeners.get(listener)?.()
				listeners.delete(listener)
			}
		},
		gc: () => current.gc?.() ?? Promise.resolve({ reclaimed: 0, done: true }),
		close: () => current.close?.() ?? Promise.resolve()
	}
	return {
		store,
		current: () => current,
		swap(next: Store) {
			const old = current
			for (const off of listeners.values()) off()
			current = next
			for (const listener of listeners.keys())
				listeners.set(listener, current.subscribe?.(listener) ?? (() => {}))
			return old
		}
	}
}

export async function createNativeStorage(options: NativeStorageOptions): Promise<NativeStorage> {
	const root = join(options.supportDir, VOLUME)
	const statePath = join(root, SYNC_STATE)
	await mkdir(root, { recursive: true })

	const savedState = await readSyncState(statePath)
	const requestedOwner = options.ownerId
	if (savedState && requestedOwner && savedState.ownerId !== requestedOwner) {
		await rm(root, { recursive: true, force: true })
		throw new OwnerChangedError()
	}
	// A signed-out process still owns its existing local replica. Keep sync wired to
	// that owner with a dynamic token source; it stays offline until the same owner
	// signs in again. Only a different signed-in owner replaces the volume.
	const ownerId = savedState?.ownerId ?? requestedOwner ?? null
	const state: SyncState = savedState ?? {
		replica: randomUUID(),
		discard: false,
		ownerId
	}
	if (!savedState) await atomicWrite(statePath, state)
	const saved = stateFile(statePath, state)

	const mainRoot = join(root, state.storeId ?? 'main')
	const privateRoot = join(root, PRIVATE)
	await Promise.all([mkdir(mainRoot, { recursive: true }), mkdir(privateRoot, { recursive: true })])

	const main = switchableStore(
		fsStore(mainRoot, {
			mounts: [PRIVATE],
			mintVersion: versions(state.replica)
		})
	)
	const privateStore = fsStore(privateRoot)
	let sync: SyncVolume | undefined
	let abortRemote: (() => void) | undefined
	let offStatus: (() => void) | undefined
	let finishFirstSync: ((synced: boolean) => void) | undefined
	let offFirstSync: (() => void) | undefined

	try {
		await announceMount(main.store, ROOT, PRIVATE)
		const bindings: Bindings = new Map([[ROOT, new Map([[PRIVATE, privateStore]])]])
		let source: Volume
		if (ownerId === null) {
			source = volume(main.store, {
				bindings,
				mintVersion: versions(state.replica)
			})
		} else {
			if (!options.getToken) throw new Error('authenticated storage needs a token source')
			const remote = remoteStore(options.getToken, options.origin, options.fetch)
			abortRemote = remote.abort
			let recovering: Promise<void> | undefined
			const recover = (): Promise<boolean> => {
				recovering ??= (async () => {
					const old = main.current()
					await preserveNative(old, privateStore, state.replica, await saved.cursor('push').load())
					const storeId = `main-bootstrap-${randomUUID()}`
					const freshRoot = join(root, storeId)
					await mkdir(freshRoot, { recursive: true })
					const fresh = fsStore(freshRoot, {
						mounts: [PRIVATE],
						mintVersion: versions(state.replica)
					})
					await announceMount(fresh, ROOT, PRIVATE)
					try {
						const pull = await bootstrap(fresh, remote.store)
						await saved.update((held) => {
							const next = { ...held, storeId, pull }
							delete next.push
							return next
						})
						main.swap(fresh)
						await closeStore(old)
					} catch (failure) {
						await closeStore(fresh)
						throw failure
					}
				})().finally(() => {
					recovering = undefined
				})
				return recovering.then(() => true)
			}
			const preflight = remote.store.open(await saved.cursor('pull').load()).then<unknown>(
				() => undefined,
				(error) => error
			)
			const result = await Promise.race([
				preflight,
				new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 25))
			])
			if (result instanceof BootstrapRequiredError) await recover()
			sync = await synced({
				local: main.store,
				remote: remote.store,
				replica: state.replica,
				pull: saved.cursor('pull'),
				push: saved.cursor('push'),
				discard: saved.discard,
				bindings,
				lazyContent: true,
				localFirst: true,
				bootstrapRequired: recover,
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
				await tracked.drain()
				await Promise.all([closeStore(main.store), closeStore(privateStore)])
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
		await Promise.allSettled([closeStore(main.store), closeStore(privateStore)])
		throw error
	}
}

function remoteStore(
	getToken: () => Promise<string | null>,
	origin = platformOrigin(),
	send: Send = fetch
): { store: LeasedRemote; abort(): void } {
	const controller = new AbortController()
	return {
		store: leasedHttpStore(new URL('/store', origin).toString(), {
			fetch: async (url, init) => {
				const headers = new Headers(init?.headers)
				headers.set('authorization', `Bearer ${(await getToken()) ?? ''}`)
				return send(url, { ...init, headers, signal: controller.signal })
			}
		}),
		abort: () => controller.abort()
	}
}

function stateFile(path: string, initial: SyncState) {
	let state = initial
	let tail: Promise<unknown> = Promise.resolve()
	const save = (change: (held: SyncState) => SyncState): Promise<void> => {
		const run = tail.then(async () => {
			state = change(state)
			await atomicWrite(path, state)
		})
		tail = run.catch(() => {})
		return run
	}
	const cursor = (key: 'pull' | 'push'): CursorSlot => ({
		async load() {
			await tail
			return state[key]
		},
		save(value) {
			return save((held) => {
				const next = { ...held }
				if (value === undefined) delete next[key]
				else next[key] = value
				return next
			})
		}
	})
	const discard: DiscardSlot = {
		async load() {
			await tail
			return state.discard
		},
		save(value) {
			return save((held) => ({ ...held, discard: value }))
		}
	}
	return { cursor, discard, update: save }
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
		(value.storeId !== undefined && typeof value.storeId !== 'string') ||
		typeof value.discard !== 'boolean' ||
		(value.ownerId !== null && typeof value.ownerId !== 'string')
	) {
		throw new Error('invalid native sync state')
	}
	return value as SyncState
}

async function atomicWrite(path: string, state: SyncState): Promise<void> {
	const temp = `${path}.tmp`
	await writeFile(temp, JSON.stringify(state), { mode: 0o600 })
	await rename(temp, path)
}

const closeStore = (store: Store): Promise<void> => store.close?.() ?? Promise.resolve()

async function preserveNative(
	local: Store,
	privateStore: Store,
	replica: string,
	cursor?: string
): Promise<void> {
	const rows = [] as ReturnType<typeof encodeNode>[]
	const blobs = new Map<string, Uint8Array>()
	for (;;) {
		const page = await local.since(cursor)
		for (const row of page.nodes) {
			if (row.id === ROOT || authorOf(row.version) !== replica) continue
			rows.push(encodeNode(row))
			if (row.deleted || row.content === undefined || blobs.has(row.content)) continue
			const data = await local.blobs.get(row.content)
			if (data === null || (await sha256Hex(data)) !== row.content)
				throw new Error(`cannot preserve pending content ${row.content}`)
			blobs.set(row.content, data)
		}
		if (page.next === undefined) throw new Error('local store returned no recovery cursor')
		cursor = page.next
		if (page.nodes.length === 0) break
	}
	if (rows.length === 0) return
	const recovery = volume(privateStore)
	const root = `/sync-recovery/${randomUUID()}`
	await recovery.mkdir('/sync-recovery', { recursive: true })
	await recovery.mkdir(root)
	await recovery.mkdir(`${root}/blobs`)
	for (const [hash, data] of blobs) await recovery.writeFile(`${root}/blobs/${hash}`, data)
	await recovery.writeFile(
		`${root}/manifest.json`,
		new TextEncoder().encode(JSON.stringify({ schema: 'frieren/sync-recovery/v1', rows }))
	)
}

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
