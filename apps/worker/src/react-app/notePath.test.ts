import { describe, expect, test } from 'vitest'
import { noteNameFromPath, notePathWithName, sanitizeNotePath } from './notePath'

describe('notePath', () => {
	test('keeps slash-separated rename input as nested folders', () => {
		expect(notePathWithName('notes/today.md', 'projects/roadmap')).toBe(
			'/notes/projects/roadmap.md'
		)
	})

	test('normalizes leading separators and backslashes in rename input', () => {
		expect(notePathWithName('notes/today.md', '/projects\\roadmap.md')).toBe(
			'/notes/projects/roadmap.md'
		)
	})

	test('keeps the scratch filename based on the basename after moving', () => {
		expect(noteNameFromPath('notes/projects/roadmap.md')).toBe('roadmap')
	})

	test('drops traversal-only segments from rename input', () => {
		expect(sanitizeNotePath('../projects/./roadmap.md')).toBe('projects/roadmap')
	})
})
