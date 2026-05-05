import type { Volume } from '@justfiles/fs'
import { nowTimestamp, systemTimezone } from './dates.ts'
import { decodeFilename, encodeFilename, isValidDue, type TaskMeta } from './parse.ts'

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
	now?: Date
}

export type Store = {
	readonly timezone: string
	addTask(opts: AddTaskOptions): Promise<Task>
	listTasks(): Promise<Task[]>
	getTask(id: string): Promise<Task | null>
	getTaskContent(id: string): Promise<string>
	completeTask(id: string): Promise<Task>
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

		async addTask({ title, content = '', due, now = new Date() }) {
			if (due !== undefined && !isValidDue(due)) {
				throw new Error(`invalid due date: ${due} (expected YYYYMMDD)`)
			}
			await ensureDir(volume, dir)
			const id = await uniqueId(generateId(now, tz))
			const meta: TaskMeta = due
				? { id, status: 'TODO', due, title }
				: { id, status: 'TODO', title }
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
			if (!task) throw new Error(`ENOENT: task ${id}`)
			const data = await volume.readFile(task.path)
			return dec.decode(data)
		},

		async completeTask(id) {
			const task = await store.getTask(id)
			if (!task) throw new Error(`task not found: ${id}`)
			if (task.status === 'DONE') return task
			const newMeta: TaskMeta = task.due
				? { id: task.id, status: 'DONE', due: task.due, title: task.title }
				: { id: task.id, status: 'DONE', title: task.title }
			const newFilename = encodeFilename(newMeta)
			const newPath = joinPath(dir, newFilename)
			await volume.rename(task.path, newPath)
			return { ...newMeta, path: newPath }
		}
	}
	return store
}
