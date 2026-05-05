import { describe, expect, test } from 'bun:test'
import { volume } from '../fs/index.ts'
import { memStorage } from '../fs/storage.mem.ts'
import { createStore, generateId } from './store.ts'

function makeStore(dir = '/tasks') {
	const vol = volume(memStorage())
	return { vol, store: createStore(vol, dir) }
}

describe('store', () => {
	test('addTask creates file with TODO status', async () => {
		const { vol, store } = makeStore()
		const task = await store.addTask({ title: 'buy milk', now: new Date('2026-05-05T10:15:30Z') })
		expect(task.status).toBe('TODO')
		expect(task.title).toBe('buy milk')
		expect(task.id).toMatch(/^\d{8}T\d{6}$/)
		expect(task.path).toContain('--TODO--buy-milk.md')
		expect(await vol.exists(task.path)).toBe(true)
	})

	test('tasks directory is auto-created', async () => {
		const { vol, store } = makeStore('/somewhere/tasks')
		expect(await vol.exists('/somewhere/tasks')).toBe(false)
		await store.addTask({ title: 'x' })
		expect(await vol.exists('/somewhere/tasks')).toBe(true)
	})

	test('listTasks returns all decoded tasks sorted by id', async () => {
		const { store } = makeStore()
		await store.addTask({ title: 'first', now: new Date('2026-05-05T10:15:30Z') })
		await store.addTask({ title: 'second', now: new Date('2026-05-05T11:15:30Z') })
		const tasks = await store.listTasks()
		expect(tasks.map((t) => t.title)).toEqual(['first', 'second'])
	})

	test('listTasks ignores non-task files', async () => {
		const { vol, store } = makeStore()
		await vol.mkdir('/tasks', { recursive: true })
		const enc = new TextEncoder()
		await vol.writeFile('/tasks/random.md', enc.encode('# hi'))
		await vol.writeFile('/tasks/notes.txt', enc.encode('notes'))
		await store.addTask({ title: 'real', now: new Date('2026-05-05T10:15:30Z') })
		const tasks = await store.listTasks()
		expect(tasks).toHaveLength(1)
		expect(tasks[0]?.title).toBe('real')
	})

	test('addTask writes provided content', async () => {
		const { vol, store } = makeStore()
		const task = await store.addTask({ title: 'x', content: 'detailed notes' })
		const data = await vol.readFile(task.path)
		expect(new TextDecoder().decode(data)).toBe('detailed notes')
	})

	test('addTask appends -N suffix on id collision', async () => {
		const { store } = makeStore()
		const fixed = new Date('2026-05-05T10:15:30Z')
		const a = await store.addTask({ title: 'a', now: fixed })
		const b = await store.addTask({ title: 'b', now: fixed })
		expect(a.id).not.toBe(b.id)
		expect(b.id.startsWith(a.id)).toBe(true)
	})

	test('listTasks on missing directory returns empty list', async () => {
		const vol = volume(memStorage())
		const store = createStore(vol, '/never-created')
		expect(await store.listTasks()).toEqual([])
	})

	test('getTask returns task by id, null when absent', async () => {
		const { store } = makeStore()
		const task = await store.addTask({ title: 'x' })
		expect(await store.getTask(task.id)).not.toBeNull()
		expect(await store.getTask('20260101T000000')).toBeNull()
	})

	test('getTaskContent returns the stored body', async () => {
		const { store } = makeStore()
		const task = await store.addTask({ title: 'x', content: 'body' })
		expect(await store.getTaskContent(task.id)).toBe('body')
	})

	test('generateId produces a denote-style timestamp', () => {
		const id = generateId(new Date('2026-05-05T10:15:30Z'))
		expect(id).toMatch(/^\d{8}T\d{6}$/)
	})

	test('completeTask transitions TODO to DONE and renames file', async () => {
		const { vol, store } = makeStore()
		const task = await store.addTask({ title: 'buy milk', now: new Date('2026-05-05T10:15:30Z') })
		expect(task.status).toBe('TODO')
		const done = await store.completeTask(task.id)
		expect(done.status).toBe('DONE')
		expect(done.id).toBe(task.id)
		expect(done.path).toContain('--DONE--')
		expect(await vol.exists(done.path)).toBe(true)
		expect(await vol.exists(task.path)).toBe(false)
	})

	test('completeTask preserves file content', async () => {
		const { store } = makeStore()
		const task = await store.addTask({ title: 'x', content: 'notes here' })
		const done = await store.completeTask(task.id)
		expect(await store.getTaskContent(done.id)).toBe('notes here')
	})

	test('completeTask is a no-op when already DONE', async () => {
		const { vol, store } = makeStore()
		const task = await store.addTask({ title: 'x', now: new Date('2026-05-05T10:15:30Z') })
		const first = await store.completeTask(task.id)
		const second = await store.completeTask(task.id)
		expect(second.status).toBe('DONE')
		expect(second.path).toBe(first.path)
		const files = (await vol.readdir('/tasks')).map((e) => e.name)
		expect(files.filter((f) => f.includes(task.id))).toHaveLength(1)
	})

	test('completeTask throws on unknown ID', async () => {
		const { store } = makeStore()
		await expect(store.completeTask('20260101T000000')).rejects.toThrow('task not found')
	})
})
