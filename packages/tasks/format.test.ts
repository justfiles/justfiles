import { describe, expect, test } from 'bun:test'
import { formatMarkdown } from './format.ts'
import type { Task } from './store.ts'

function task(id: string, title: string): Task {
	return { id, status: 'TODO', title, path: `/tasks/${id}--TODO--${title}.md` }
}

describe('format', () => {
	test('formatMarkdown renders a bullet list with id and title', () => {
		const out = formatMarkdown([
			task('20260505T101530', 'buy-milk'),
			task('20260505T111530', 'write-report')
		])
		expect(out).toBe('- [20260505T101530] buy-milk\n- [20260505T111530] write-report\n')
	})

	test('formatMarkdown handles empty list', () => {
		expect(formatMarkdown([])).toBe('No tasks.\n')
	})
})
