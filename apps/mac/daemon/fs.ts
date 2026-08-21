import { constants } from 'node:fs'
import { type FileHandle, mkdir, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { announceMount, type Bindings, type Volume, volume } from '@justfiles/fs'
import { fsStore } from '@justfiles/fs/fs'
import { ROOT, type Store } from '@justfiles/fs/store'

// Where the daemon keeps its Volume + runtime.json. Overridable via FRIEREN_SUPPORT_DIR so a test
// can point it at a temp dir and never touch the real support tree; read lazily (a
// function, not a const) so a test can set the env before the first getVolume/writeRuntime.
const supportDir = (): string =>
	process.env.FRIEREN_SUPPORT_DIR ?? join(homedir(), 'Library', 'Application Support', 'Kodama')
const runtimePath = (): string => join(supportDir(), 'runtime.json')
const lockPath = (): string => join(supportDir(), 'daemon.lock')
const PRIVATE = 'private'

// macOS O_EXLOCK. Node and Bun pass numeric open flags through but do not publish this constant.
// The kernel releases the lock when this process closes the handle or dies.
const O_EXLOCK = 0x20

export interface Runtime {
	port: number
	token: string
	pid: number
}

interface StorageOwner {
	volume: Volume
	close(): Promise<void>
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

// One owner per process. The kernel and agent share its mounted Volume, while the owner keeps
// both native Stores private and closes them together.
let storageOnce: Promise<StorageOwner> | undefined

function getStorage(): Promise<StorageOwner> {
	storageOnce ??= (async () => {
		const root = join(supportDir(), 'volume-v2')
		const mainRoot = join(root, 'main')
		const privateRoot = join(root, PRIVATE)
		await Promise.all([
			mkdir(mainRoot, { recursive: true }),
			mkdir(privateRoot, { recursive: true })
		])

		const mainStore = fsStore(mainRoot, { mounts: [PRIVATE] })
		const privateStore = fsStore(privateRoot)
		try {
			await announceMount(mainStore, ROOT, PRIVATE)
			const bindings: Bindings = new Map([[ROOT, new Map([[PRIVATE, privateStore]])]])
			const tracked = trackVolume(volume(mainStore, { bindings }))
			let closeOnce: Promise<void> | undefined
			return {
				volume: tracked.volume,
				close() {
					closeOnce ??= (async () => {
						await tracked.drain()
						await Promise.all([closeStore(mainStore), closeStore(privateStore)])
					})()
					return closeOnce
				}
			}
		} catch (error) {
			await Promise.allSettled([closeStore(mainStore), closeStore(privateStore)])
			throw error
		}
	})()
	return storageOnce
}

const closeStore = (store: Store): Promise<void> => store.close?.() ?? Promise.resolve()

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
