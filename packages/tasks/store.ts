import type { Volume } from '@justfiles/fs'
import { nowTimestamp, systemTimezone, today } from './dates.ts'
import { decodeFilename, encodeFilename, isValidDue, type Recur, type TaskMeta } from './parse.ts'
import { nextDue } from './recur.ts'

export type Task = TaskMeta & {
	path: string
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export type StoreOptions = {
	timezone?: string
}

export type AddTaskOptions = {
	title: string
	content?: string
	due?: string
	tags?: string[]
	priority?: 1 | 2 | 3
	recur?: Recur
	now?: Date
}

export type SetTaskPatch = {
	status?: string
	due?: string | null
	title?: string
	tags?: string[]
	priority?: 1 | 2 | 3 | null
	recur?: Recur | null
}

export type Store = {
	readonly timezone: string
	addTask(opts: AddTaskOptions): Promise<Task>
	listTasks(): Promise<Task[]>
	getTask(id: string): Promise<Task | null>
	getTaskContent(id: string): Promise<string>
	setTaskContent(id: string, content: string): Promise<void>
	deleteTask(id: string): Promise<void>
	setTask(id: string, patch: SetTaskPatch): Promise<Task>
	completeTask(id: string, now?: Date): Promise<Task>
}

export function generateId(now: Date, tz: string = systemTimezone()): string {
	return nowTimestamp(tz, now)
}

async function ensureDir(volume: Volume, path: string): Promise<void> {
	if (await volume.exists(path)) return
	await volume.mkdir(path, { recursive: true })
}

async function readEntries(volume: Volume, dir: string): Promise<string[]> {
	if (!(await volume.exists(dir))) return []
	const entries = await volume.readdir(dir)
	return entries.map((e) => e.name)
}

function joinPath(dir: string, name: string): string {
	return dir === '/' ? `/${name}` : `${dir}/${name}`
}

export function createStore(volume: Volume, dir: string, options: StoreOptions = {}): Store {
	const tz = options.timezone ?? systemTimezone()

	async function uniqueId(base: string): Promise<string> {
		const names = await readEntries(volume, dir)
		const taken = new Set(
			names
				.map(decodeFilename)
				.filter((m): m is TaskMeta => m !== null)
				.map((m) => m.id)
		)
		if (!taken.has(base)) return base
		let n = 1
		while (taken.has(`${base}-${n}`)) n++
		return `${base}-${n}`
	}

	const store: Store = {
		timezone: tz,

		async addTask({ title, content = '', due, tags = [], priority, recur, now = new Date() }) {
			if (due !== undefined && !isValidDue(due)) {
				throw new Error(`invalid due date: ${due} (expected YYYYMMDD)`)
			}
			await ensureDir(volume, dir)
			const id = await uniqueId(generateId(now, tz))
			const meta: TaskMeta = {
				id,
				status: 'TODO',
				title,
				tags,
				...(due ? { due } : {}),
				...(priority ? { priority } : {}),
				...(recur ? { recur } : {})
			}
			const filename = encodeFilename(meta)
			const path = joinPath(dir, filename)
			await volume.writeFile(path, enc.encode(content))
			return { ...meta, path }
		},

		async listTasks() {
			const names = await readEntries(volume, dir)
			const tasks: Task[] = []
			for (const name of names) {
				const meta = decodeFilename(name)
				if (!meta) continue
				tasks.push({ ...meta, path: joinPath(dir, name) })
			}
			tasks.sort((a, b) => a.id.localeCompare(b.id))
			return tasks
		},

		async getTask(id) {
			const tasks = await store.listTasks()
			return tasks.find((t) => t.id === id) ?? null
		},

		async getTaskContent(id) {
			const task = await store.getTask(id)
			if (!task) throw new Error(`task not found: ${id}`)
			const data = await volume.readFile(task.path)
			return dec.decode(data)
		},

		async setTaskContent(id, content) {
			const task = await store.getTask(id)
			if (!task) throw new Error(`task not found: ${id}`)
			await volume.writeFile(task.path, enc.encode(content))
		},

		async deleteTask(id) {
			const task = await store.getTask(id)
			if (!task) throw new Error(`task not found: ${id}`)
			await volume.rm(task.path)
		},

		async setTask(id, patch) {
			const task = await store.getTask(id)
			if (!task) throw new Error(`task not found: ${id}`)
			if (patch.status === '') {
				throw new Error('invalid status: cannot be empty')
			}
			if (patch.due !== undefined && patch.due !== null && !isValidDue(patch.due)) {
				throw new Error(`invalid due date: ${patch.due} (expected YYYYMMDD)`)
			}
			const next: TaskMeta = {
				id: task.id,
				status: patch.status ?? task.status,
				title: patch.title ?? task.title,
				tags: patch.tags ?? task.tags,
				...(patch.due === undefined
					? task.due
						? { due: task.due }
						: {}
					: patch.due
						? { due: patch.due }
						: {}),
				...(patch.priority === undefined
					? task.priority
						? { priority: task.priority }
						: {}
					: patch.priority
						? { priority: patch.priority }
						: {}),
				...(patch.recur === undefined
					? task.recur
						? { recur: task.recur }
						: {}
					: patch.recur
						? { recur: patch.recur }
						: {})
			}
			const newPath = joinPath(dir, encodeFilename(next))
			await volume.rename(task.path, newPath)
			return { ...next, path: newPath }
		},

		async completeTask(id, now = new Date()) {
			const task = await store.getTask(id)
			if (!task) throw new Error(`task not found: ${id}`)
			if (task.status === 'DONE') return task
			const doneMeta: TaskMeta = {
				id: task.id,
				status: 'DONE',
				title: task.title,
				tags: task.tags,
				...(task.due ? { due: task.due } : {}),
				...(task.priority ? { priority: task.priority } : {}),
				...(task.recur ? { recur: task.recur } : {})
			}
			const donePath = joinPath(dir, encodeFilename(doneMeta))
			await volume.rename(task.path, donePath)
			if (task.recur) {
				const completedAt = today(tz, now)
				const due = nextDue(task.due, task.recur, completedAt)
				const nextId = await uniqueId(generateId(now, tz))
				const nextMeta: TaskMeta = {
					id: nextId,
					status: 'TODO',
					title: task.title,
					tags: task.tags,
					due,
					...(task.priority ? { priority: task.priority } : {}),
					recur: task.recur
				}
				const nextPath = joinPath(dir, encodeFilename(nextMeta))
				await volume.writeFile(nextPath, enc.encode(''))
				return { ...nextMeta, path: nextPath }
			}
			return { ...doneMeta, path: donePath }
		}
	}
	return store
}
