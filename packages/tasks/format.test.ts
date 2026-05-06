import { describe, expect, test } from 'bun:test'
import { formatIds, formatJson, formatMarkdown, formatSections } from './format.ts'
import { groupTasks } from './query.ts'
import type { Task } from './store.ts'

function task(id: string, title: string, due?: string, priority?: 1 | 2 | 3): Task {
	return {
		id,
		status: 'TODO',
		title,
		tags: [],
		path: `/tasks/${id}.md`,
		...(due ? { due } : {}),
		...(priority ? { priority } : {})
	}
}

describe('format', () => {
	test('formatMarkdown renders a bullet list with id and title', () => {
		const out = formatMarkdown([
			task('20260505T101530', 'buy-milk'),
			task('20260505T111530', 'write-report')
		])
		expect(out).toBe('- [20260505T101530] buy-milk\n- [20260505T111530] write-report\n')
	})

	test('formatMarkdown shows priority prefix when set', () => {
		const out = formatMarkdown([
			task('20260505T101530', 'urgent-fix', undefined, 1),
			task('20260505T111530', 'normal-task')
		])
		expect(out).toBe('- [20260505T101530] [p1] urgent-fix\n- [20260505T111530] normal-task\n')
	})

	test('formatMarkdown omits priority prefix when not set', () => {
		const out = formatMarkdown([task('20260505T101530', 'no-priority')])
		expect(out).not.toContain('[p')
	})

	test('formatMarkdown handles empty list', () => {
		expect(formatMarkdown([])).toBe('No tasks.\n')
	})

	test('formatSections renders all four sections in order', () => {
		const sections = groupTasks(
			[
				task('20260601T100000', 'past', '20260610'),
				task('20260615T100000', 'now', '20260615'),
				task('20260620T100000', 'future', '20260620'),
				task('20260605T100000', 'someday')
			],
			'20260615'
		)
		const out = formatSections(sections)
		expect(out).toBe(
			[
				'# overdue',
				'',
				'- [20260601T100000] past',
				'',
				'# today',
				'',
				'- [20260615T100000] now',
				'',
				'# upcoming',
				'',
				'- [20260620T100000] future',
				'',
				'# undated',
				'',
				'- [20260605T100000] someday',
				''
			].join('\n')
		)
	})

	test('formatSections omits empty sections', () => {
		const sections = groupTasks(
			[task('20260601T100000', 'past', '20260610'), task('20260620T100000', 'future', '20260620')],
			'20260615'
		)
		const out = formatSections(sections)
		expect(out).toContain('# overdue')
		expect(out).toContain('# upcoming')
		expect(out).not.toContain('# today')
		expect(out).not.toContain('# undated')
	})

	test('formatSections collapses headers when only one section has tasks', () => {
		const sections = groupTasks(
			[task('20260605T100000', 'a'), task('20260606T100000', 'b')],
			'20260615'
		)
		const out = formatSections(sections)
		expect(out).toBe('- [20260605T100000] a\n- [20260606T100000] b\n')
		expect(out).not.toContain('#')
	})

	test('formatSections handles all-empty input', () => {
		const sections = groupTasks([], '20260615')
		expect(formatSections(sections)).toBe('No tasks.\n')
	})

	test('formatJson renders task fields as a JSON array', () => {
		const out = formatJson([task('20260505T101530', 'pay-bill', '20260506', 1)])
		expect(JSON.parse(out)).toEqual([
			{
				id: '20260505T101530',
				status: 'TODO',
				due: '20260506',
				title: 'pay-bill',
				tags: [],
				priority: 1,
				path: '/tasks/20260505T101530.md'
			}
		])
	})

	test('formatJson handles empty input', () => {
		expect(formatJson([])).toBe('[]\n')
	})

	test('formatIds renders filenames in input order', () => {
		const out = formatIds([task('20260505T101530', 'first'), task('20260505T111530', 'second')])
		expect(out).toBe('20260505T101530.md\n20260505T111530.md')
	})

	test('formatIds handles empty input without a trailing newline', () => {
		expect(formatIds([])).toBe('')
	})
})
