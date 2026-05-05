import { type Volume, volume } from '@justfiles/fs'
import { nativeStorage } from '@justfiles/fs/storage/fs'
import { systemTimezone } from './dates.ts'
import { createStore, type Store } from './store.ts'

export type { TaskMeta } from './parse.ts'
export type { SectionKey, Sections } from './query.ts'
export type { Task } from './store.ts'

export type TaskManagerOptions = {
	timezone?: string
}

export type TaskManager = Store

function isVolume(x: unknown): x is Volume {
	return typeof x === 'object' && x !== null && typeof (x as Volume).readFile === 'function'
}

async function volumeForPath(path: string): Promise<{ volume: Volume; root: string }> {
	const { mkdirSync, existsSync } = await import('node:fs')
	if (!existsSync(path)) {
		mkdirSync(path, { recursive: true })
	}
	const storage = await nativeStorage(path)
	return { volume: volume(storage), root: '/' }
}

export async function createTaskManager(
	pathOrVolume: string | Volume,
	options: TaskManagerOptions = {}
): Promise<TaskManager> {
	const tz = options.timezone ?? systemTimezone()
	if (isVolume(pathOrVolume)) {
		return createStore(pathOrVolume, '/', { timezone: tz })
	}
	const { volume: vol, root } = await volumeForPath(pathOrVolume)
	return createStore(vol, root, { timezone: tz })
}
