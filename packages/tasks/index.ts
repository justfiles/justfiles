import type { Volume } from '@justfiles/fs'
import { systemTimezone } from './dates.ts'
import { createStore, type Store } from './store.ts'

export type { Recur, TaskMeta } from './parse.ts'
export type { SectionKey, Sections } from './query.ts'
export type { Task } from './store.ts'

export type TaskManagerOptions = {
	timezone?: string
}

export type TaskManager = Store

export function createTaskManager(
	volume: Volume,
	root: string = '/',
	options: TaskManagerOptions = {}
): TaskManager {
	const tz = options.timezone ?? systemTimezone()
	return createStore(volume, root, { timezone: tz })
}
