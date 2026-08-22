import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { type FileHandle, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { announceMount, type Bindings, type Volume, volume } from '@justfiles/fs'
import { fsStore } from '@justfiles/fs/fs'
import { httpStore } from '@justfiles/fs/http'
import { ROOT, type Store } from '@justfiles/fs/store'
import {
	type CursorSlot,
	type DiscardSlot,
	type SyncStatus,
	synced,
	versions
} from '@justfiles/fs/synced'
import { SHIPPED } from './resources'

const supportDir = (): string =>
	process.env.FRIEREN_SUPPORT_DIR ?? join(homedir(), 'Library', 'Application Support', 'Kodama')
const runtimePath = (): string => join(supportDir(), 'runtime.json')
const lockPath = (): string => join(supportDir(), 'daemon.lock')
const PRIVATE = 'private'
const VOLUME = 'volume-v2'
const SYNC_STATE = 'sync.json'
const PROD_ORIGIN = 'https://mykodama.app'
const DEV_ORIGIN = 'https://staging.mykodama.app'
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

export async function createNativeStorage(options: NativeStorageOptions): Promise<NativeStorage> {
	const root = join(options.supportDir, VOLUME)
	const statePath = join(root, SYNC_STATE)
	await mkdir(root, { recursive: true })

	const savedState = await readSyncState(statePath)
	if (savedState && options.ownerId !== undefined && savedState.ownerId !== options.ownerId) {
		await rm(root, { recursive: true, force: true })
		throw new OwnerChangedError()
	}
	const ownerId = options.ownerId === undefined ? (savedState?.ownerId ?? null) : options.ownerId
	const state: SyncState = savedState ?? {
		replica: randomUUID(),
		discard: false,
		ownerId
	}
	if (!savedState) await atomicWrite(statePath, state)
	const saved = stateFile(statePath, state)

	const mainRoot = join(root, 'main')
	const privateRoot = join(root, PRIVATE)
	await Promise.all([mkdir(mainRoot, { recursive: true }), mkdir(privateRoot, { recursive: true })])

	const mainStore = fsStore(mainRoot, {
		mounts: [PRIVATE],
		mintVersion: versions(state.replica)
	})
	const privateStore = fsStore(privateRoot)
	let sync: SyncVolume | undefined
	let abortRemote: (() => void) | undefined
	let offStatus: (() => void) | undefined

	try {
		await announceMount(mainStore, ROOT, PRIVATE)
		const bindings: Bindings = new Map([[ROOT, new Map([[PRIVATE, privateStore]])]])
		let source: Volume
		if (ownerId === null) {
			source = volume(mainStore, {
				bindings,
				mintVersion: versions(state.replica)
			})
		} else {
			if (!options.getToken) throw new Error('authenticated storage needs a token source')
			const remote = remoteStore(options.getToken, options.origin, options.fetch)
			abortRemote = remote.abort
			sync = await synced({
				local: mainStore,
				remote: remote.store,
				replica: state.replica,
				pull: saved.cursor('pull'),
				push: saved.cursor('push'),
				discard: saved.discard,
				bindings,
				lazyContent: true,
				localFirst: true,
				interval: options.interval
			})
			console.info(`sync: ${sync.status()}`)
			offStatus = sync.onStatusChange((status) => console.info(`sync: ${status}`))
			source = sync
		}

		const tracked = trackVolume(source)
		let stopOnce: Promise<void> | undefined
		let closeOnce: Promise<void> | undefined
		let removeOnce: Promise<void> | undefined

		const stopSync = (): Promise<void> => {
			if (!sync) return Promise.resolve()
			if (!stopOnce) {
				offStatus?.()
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
				await Promise.all([closeStore(mainStore), closeStore(privateStore)])
			})()
			return closeOnce
		}

		return {
			volume: tracked.volume,
			ownerId,
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

function remoteStore(
	getToken: () => Promise<string | null>,
	origin = process.env.KODAMA_STORE_ORIGIN ?? (SHIPPED ? PROD_ORIGIN : DEV_ORIGIN),
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
	return { cursor, discard }
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

async function atomicWrite(path: string, state: SyncState): Promise<void> {
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

function getStorage(): Promise<NativeStorage> {
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
