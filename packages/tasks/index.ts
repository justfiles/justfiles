import { type Volume, volume } from '@justfiles/fs'
import { nativeStorage } from '@justfiles/fs/storage/fs'
import { systemTimezone } from './dates.ts'
import { createStore, type Store } from './store.ts'

export type { Recur, TaskMeta } from './parse.ts'
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

export async function findLocalTasksDir(cwd: string = process.cwd()): Promise<string | null> {
	const { existsSync, statSync } = await import('node:fs')
	const { dirname, join, resolve } = await import('node:path')
	const home = resolve((await import('node:os')).homedir())
	let dir = resolve(cwd)
	while (true) {
		const tasks = join(dir, 'tasks')
		if (existsSync(tasks) && statSync(tasks).isDirectory()) return tasks
		if (existsSync(join(dir, '.git')) || dir === home) return null
		const parent = dirname(dir)
		if (parent === dir) return null
		dir = parent
	}
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
