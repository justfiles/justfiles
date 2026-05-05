import type { Volume } from '@justfiles/fs'
import { decodeFilename, encodeFilename, type TaskMeta } from './parse.ts'

export type Task = TaskMeta & {
	path: string
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export type Store = {
	addTask(opts: { title: string; content?: string; now?: Date }): Promise<Task>
	listTasks(): Promise<Task[]>
	getTask(id: string): Promise<Task | null>
	getTaskContent(id: string): Promise<string>
	completeTask(id: string): Promise<Task>
}

function pad(n: number, width: number): string {
	return n.toString().padStart(width, '0')
}

export function generateId(now: Date): string {
	return (
		`${now.getFullYear()}${pad(now.getMonth() + 1, 2)}${pad(now.getDate(), 2)}` +
		`T${pad(now.getHours(), 2)}${pad(now.getMinutes(), 2)}${pad(now.getSeconds(), 2)}`
	)
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

export function createStore(volume: Volume, dir: string): Store {
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

	return {
		async addTask({ title, content = '', now = new Date() }) {
			await ensureDir(volume, dir)
			const id = await uniqueId(generateId(now))
			const meta: TaskMeta = { id, status: 'TODO', title }
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
			const tasks = await this.listTasks()
			return tasks.find((t) => t.id === id) ?? null
		},

		async getTaskContent(id) {
			const task = await this.getTask(id)
			if (!task) throw new Error(`ENOENT: task ${id}`)
			const data = await volume.readFile(task.path)
			return dec.decode(data)
		},

		async completeTask(id) {
			const task = await this.getTask(id)
			if (!task) throw new Error(`task not found: ${id}`)
			if (task.status === 'DONE') return task
			const newMeta: TaskMeta = { id: task.id, status: 'DONE', title: task.title }
			const newFilename = encodeFilename(newMeta)
			const newPath = joinPath(dir, newFilename)
			await volume.rename(task.path, newPath)
			return { ...newMeta, path: newPath }
		}
	}
}
