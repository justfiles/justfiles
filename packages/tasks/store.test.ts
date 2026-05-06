import { describe, expect, test } from 'bun:test'
import { volume } from '../fs/index.ts'
import { memStorage } from '../fs/storage.mem.ts'
import { createStore, generateId } from './store.ts'

function makeStore(dir = '/tasks', timezone = 'UTC') {
	const vol = volume(memStorage())
	return { vol, store: createStore(vol, dir, { timezone }) }
}

describe('store', () => {
	test('addTask creates file with TODO status', async () => {
		const { vol, store } = makeStore()
		const task = await store.addTask({ title: 'buy milk', now: new Date('2026-05-05T10:15:30Z') })
		expect(task.status).toBe('TODO')
		expect(task.title).toBe('buy milk')
		expect(task.id).toMatch(/^\d{8}T\d{6}$/)
		expect(task.path).toContain('--TODO--buy-milk.md')
		expect(task.tags).toEqual([])
		expect(task.priority).toBeUndefined()
		expect(await vol.exists(task.path)).toBe(true)
	})

	test('addTask with tags and priority encodes them in filename', async () => {
		const { vol, store } = makeStore()
		const task = await store.addTask({
			title: 'fix bug',
			tags: ['work', 'urgent'],
			priority: 1,
			now: new Date('2026-05-05T10:15:30Z')
		})
		expect(task.tags).toEqual(['work', 'urgent'])
		expect(task.priority).toBe(1)
		expect(task.path).toContain('__work__urgent__p1.md')
		expect(await vol.exists(task.path)).toBe(true)
	})

	test('completeTask preserves tags and priority', async () => {
		const { store } = makeStore()
		const task = await store.addTask({
			title: 'pay bill',
			tags: ['finance'],
			priority: 2,
			now: new Date('2026-05-05T10:15:30Z')
		})
		const done = await store.completeTask(task.id)
		expect(done.tags).toEqual(['finance'])
		expect(done.priority).toBe(2)
		expect(done.path).toContain('__finance__p2.md')
	})

	test('addTask with --due encodes the date in the filename', async () => {
		const { vol, store } = makeStore()
		const task = await store.addTask({
			title: 'pay bill',
			due: '20260615',
			now: new Date('2026-05-05T10:15:30Z')
		})
		expect(task.due).toBe('20260615')
		expect(task.path).toContain('--TODO--20260615--pay-bill.md')
		expect(await vol.exists(task.path)).toBe(true)
	})

	test('addTask rejects invalid due format', async () => {
		const { store } = makeStore()
		await expect(store.addTask({ title: 'x', due: '2026-06-15' })).rejects.toThrow('invalid due')
	})

	test('store exposes its configured timezone', () => {
		const { store } = makeStore('/tasks', 'Pacific/Auckland')
		expect(store.timezone).toBe('Pacific/Auckland')
	})

	test('generateId uses the configured timezone', async () => {
		// 2026-05-05 23:30 UTC → next day in Auckland
		const { store } = makeStore('/tasks', 'Pacific/Auckland')
		const task = await store.addTask({ title: 'x', now: new Date('2026-05-05T23:30:00Z') })
		expect(task.id.slice(0, 8)).toBe('20260506')
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

	test('setTaskContent replaces the stored body', async () => {
		const { store } = makeStore()
		const task = await store.addTask({ title: 'x', content: 'body' })
		await store.setTaskContent(task.id, 'updated')
		expect(await store.getTaskContent(task.id)).toBe('updated')
	})

	test('deleteTask removes the task file', async () => {
		const { vol, store } = makeStore()
		const task = await store.addTask({ title: 'x' })
		await store.deleteTask(task.id)
		expect(await vol.exists(task.path)).toBe(false)
		expect(await store.getTask(task.id)).toBeNull()
	})

	test('deleteTask throws on unknown ID', async () => {
		const { store } = makeStore()
		await expect(store.deleteTask('20260101T000000')).rejects.toThrow('task not found')
	})

	test('setTask changes status', async () => {
		const { store } = makeStore()
		const task = await store.addTask({ title: 'x' })
		const updated = await store.setTask(task.id, { status: 'WAITING' })
		expect(updated.status).toBe('WAITING')
		expect(updated.path).toContain('--WAITING--')
	})

	test('setTask changes due date and preserves other fields', async () => {
		const { vol, store } = makeStore()
		const task = await store.addTask({
			title: 'pay bill',
			due: '20260615',
			tags: ['finance'],
			priority: 1
		})
		const updated = await store.setTask(task.id, { due: '20260620' })
		expect(updated.due).toBe('20260620')
		expect(updated.tags).toEqual(['finance'])
		expect(updated.priority).toBe(1)
		expect(updated.path).toContain('--TODO--20260620--pay-bill__finance__p1.md')
		expect(await vol.exists(task.path)).toBe(false)
		expect(await vol.exists(updated.path)).toBe(true)
	})

	test('setTask clears due date and priority', async () => {
		const { store } = makeStore()
		const task = await store.addTask({ title: 'x', due: '20260615', priority: 2 })
		const updated = await store.setTask(task.id, { due: null, priority: null })
		expect(updated.due).toBeUndefined()
		expect(updated.priority).toBeUndefined()
		expect(updated.path).toContain('--TODO--x.md')
	})

	test('setTask changes title, tags, and priority together', async () => {
		const { store } = makeStore()
		const task = await store.addTask({ title: 'x', tags: ['old'], priority: 3 })
		const updated = await store.setTask(task.id, {
			title: 'New Title',
			tags: ['work', 'urgent'],
			priority: 1
		})
		expect(updated.title).toBe('New Title')
		expect(updated.tags).toEqual(['work', 'urgent'])
		expect(updated.priority).toBe(1)
		expect(updated.path).toContain('--new-title__work__urgent__p1.md')
	})

	test('setTask throws on unknown ID', async () => {
		const { store } = makeStore()
		await expect(store.setTask('20260101T000000', { status: 'WAITING' })).rejects.toThrow(
			'task not found'
		)
	})

	test('setTask rejects empty status', async () => {
		const { store } = makeStore()
		const task = await store.addTask({ title: 'x' })
		await expect(store.setTask(task.id, { status: '' })).rejects.toThrow('invalid status')
	})

	test('generateId produces a denote-style timestamp', () => {
		const id = generateId(new Date('2026-05-05T10:15:30Z'), 'UTC')
		expect(id).toBe('20260505T101530')
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

	test('completeTask preserves the due date', async () => {
		const { store } = makeStore()
		const task = await store.addTask({ title: 'x', due: '20260615' })
		const done = await store.completeTask(task.id)
		expect(done.due).toBe('20260615')
		expect(done.path).toContain('--DONE--20260615--x.md')
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

	test('end-to-end: add+list groups tasks via query.groupTasks', async () => {
		const { store } = makeStore('/tasks', 'UTC')
		await store.addTask({
			title: 'past',
			due: '20260610',
			now: new Date('2026-06-01T10:00:00Z')
		})
		await store.addTask({
			title: 'now',
			due: '20260615',
			now: new Date('2026-06-02T10:00:00Z')
		})
		await store.addTask({
			title: 'future',
			due: '20260620',
			now: new Date('2026-06-03T10:00:00Z')
		})
		await store.addTask({ title: 'someday', now: new Date('2026-06-04T10:00:00Z') })
		const tasks = await store.listTasks()
		const { groupTasks } = await import('./query.ts')
		const sections = groupTasks(tasks, '20260615')
		expect(sections.overdue.map((t) => t.title)).toEqual(['past'])
		expect(sections.today.map((t) => t.title)).toEqual(['now'])
		expect(sections.upcoming.map((t) => t.title)).toEqual(['future'])
		expect(sections.undated.map((t) => t.title)).toEqual(['someday'])
	})
})
