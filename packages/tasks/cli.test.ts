import { afterEach, describe, expect, test } from 'bun:test'
import { _picker, formatPickerEntry } from './cli.ts'
import type { Task } from './store.ts'

function makeTask(overrides: Partial<Task> & { title: string }): Task {
	return {
		id: '20260502T122918',
		status: 'TODO',
		tags: [],
		path: '/20260502T122918--TODO--task.md',
		...overrides
	}
}

describe('formatPickerEntry', () => {
	test('minimal task (title only)', () => {
		const line = formatPickerEntry(makeTask({ title: 'buy milk' }))
		expect(line).toBe('20260502T122918  buy milk')
	})

	test('task with due date', () => {
		const line = formatPickerEntry(makeTask({ title: 'pay bill', due: '20260510' }))
		expect(line).toBe('20260502T122918  pay bill  due:20260510')
	})

	test('task with priority', () => {
		const line = formatPickerEntry(makeTask({ title: 'fix bug', priority: 1 }))
		expect(line).toBe('20260502T122918  fix bug  p1')
	})

	test('task with tags', () => {
		const line = formatPickerEntry(makeTask({ title: 'write tests', tags: ['work', 'dev'] }))
		expect(line).toBe('20260502T122918  write tests  [work,dev]')
	})

	test('task with all metadata', () => {
		const line = formatPickerEntry(
			makeTask({ title: 'ship feature', due: '20260507', priority: 2, tags: ['work'] })
		)
		expect(line).toBe('20260502T122918  ship feature  due:20260507  p2  [work]')
	})
})

describe('_picker.fzf injection', () => {
	const originalFzf = _picker.fzf

	afterEach(() => {
		_picker.fzf = originalFzf
	})

	test('ID is extracted as first whitespace-delimited token from selected line', () => {
		_picker.fzf = (_input: string) => ({
			status: 0,
			stdout: '20260502T122918  buy milk  due:20260510\n'
		})
		const result = _picker.fzf('anything')
		const id = result.stdout.trim().split(/\s+/)[0]
		expect(id).toBe('20260502T122918')
	})

	test('cancelled picker (non-zero status) is detected', () => {
		_picker.fzf = (_input: string) => ({ status: 130, stdout: '' })
		const result = _picker.fzf('anything')
		expect(result.status).not.toBe(0)
	})

	test('fzf not found (error set) is detected', () => {
		_picker.fzf = (_input: string) => ({
			status: null,
			stdout: '',
			error: new Error('ENOENT')
		})
		const result = _picker.fzf('anything')
		expect(result.error).toBeDefined()
	})

	test('formatPickerEntry output feeds correct ID into picker input', () => {
		const task = makeTask({ title: 'deploy app', due: '20260508', priority: 1, tags: ['infra'] })
		const entry = formatPickerEntry(task)
		// Entry starts with the task ID
		expect(entry.startsWith(task.id)).toBe(true)
		// First token of entry is the task ID
		const firstToken = entry.split(/\s+/)[0]
		expect(firstToken).toBe(task.id)
	})
})
