import { describe, expect, test } from 'bun:test'
import { groupTasks } from './query.ts'
import type { Task } from './store.ts'

function task(partial: Partial<Task> & { id: string; title: string }): Task {
	return {
		status: 'TODO',
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
