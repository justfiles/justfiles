import { existsSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { volume } from '@justfiles/fs'
import { fsStore } from '@justfiles/fs/fs'
import { createTaskManager, type TaskManager, type TaskManagerOptions } from './index.ts'

export async function findLocalTasksDir(cwd: string = process.cwd()): Promise<string | null> {
	const home = resolve(homedir())
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

export async function createNodeTaskManager(
	path: string,
	options: TaskManagerOptions = {}
): Promise<TaskManager> {
	if (!existsSync(path)) {
		mkdirSync(path, { recursive: true })
	}
	const store = fsStore(path)
	return createTaskManager(volume(store), '/', options)
}
