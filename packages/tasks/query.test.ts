import { describe, expect, test } from 'bun:test'
import { filterTasks, groupTasks } from './query.ts'
import type { Task } from './store.ts'

function task(partial: Partial<Task> & { id: string; title: string }): Task {
	return {
		status: 'TODO',
		tags: [],
		path: `/tasks/${partial.id}.md`,
		...partial
	}
}

describe('query', () => {
	test('groupTasks splits into overdue/today/upcoming/undated', () => {
		const today = '20260615'
		const tasks: Task[] = [
			task({ id: '20260601T100000', title: 'past', due: '20260610' }),
			task({ id: '20260615T100000', title: 'now', due: today }),
			task({ id: '20260620T100000', title: 'future', due: '20260620' }),
			task({ id: '20260605T100000', title: 'someday' })
		]
		const sections = groupTasks(tasks, today)
		expect(sections.overdue.map((t) => t.title)).toEqual(['past'])
		expect(sections.today.map((t) => t.title)).toEqual(['now'])
		expect(sections.upcoming.map((t) => t.title)).toEqual(['future'])
		expect(sections.undated.map((t) => t.title)).toEqual(['someday'])
	})

	test('DONE tasks with past due never appear in overdue', () => {
		const tasks: Task[] = [
			task({ id: '20260601T100000', title: 'finished', status: 'DONE', due: '20260610' })
		]
		const sections = groupTasks(tasks, '20260615')
		expect(sections.overdue).toHaveLength(0)
	})

	test('all sections empty produces empty Sections', () => {
		const sections = groupTasks([], '20260615')
		expect(sections.overdue).toEqual([])
		expect(sections.today).toEqual([])
		expect(sections.upcoming).toEqual([])
		expect(sections.undated).toEqual([])
	})
})

describe('filterTasks', () => {
	const tasks = [
		task({ id: '20260601T100000', title: 'a', tags: ['work', 'urgent'], priority: 1 }),
		task({ id: '20260602T100000', title: 'b', tags: ['work'], priority: 2 }),
		task({ id: '20260603T100000', title: 'c', tags: ['personal'] }),
		task({ id: '20260604T100000', title: 'd', tags: [] })
	]

	test('filters by single tag', () => {
		const result = filterTasks(tasks, { tags: ['work'] })
		expect(result.map((t) => t.title)).toEqual(['a', 'b'])
	})

	test('filters by multiple tags (AND)', () => {
		const result = filterTasks(tasks, { tags: ['work', 'urgent'] })
		expect(result.map((t) => t.title)).toEqual(['a'])
	})

	test('filters by priority', () => {
		const result = filterTasks(tasks, { priority: 1 })
		expect(result.map((t) => t.title)).toEqual(['a'])
	})

	test('tag and priority filters compose as AND', () => {
		const result = filterTasks(tasks, { tags: ['work'], priority: 2 })
		expect(result.map((t) => t.title)).toEqual(['b'])
	})

	test('no filters returns all tasks', () => {
		const result = filterTasks(tasks, {})
		expect(result).toHaveLength(4)
	})

	test('tag not present returns empty', () => {
		const result = filterTasks(tasks, { tags: ['nonexistent'] })
		expect(result).toHaveLength(0)
	})
})
