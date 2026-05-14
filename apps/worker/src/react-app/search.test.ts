import { describe, expect, test } from 'vitest'
import { type FuzzyPathItem, searchPaths } from './search'

function createItems(paths: string[]): FuzzyPathItem[] {
	return paths.map((path, index) => ({
		id: `item-${index}`,
		path,
		active: 1,
		updated_at: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`
	}))
}

function pathsFor(query: string, paths: string[]): string[] {
	return searchPaths(createItems(paths), query).map((item) => item.path)
}

describe('searchPaths', () => {
	test('returns no results for an empty query', () => {
		expect(pathsFor('', ['projects/idea.md'])).toEqual([])
		expect(pathsFor('   ', ['projects/idea.md'])).toEqual([])
	})

	test('ignores a leading slash in the query', () => {
		expect(pathsFor('/projects/idea', ['projects/idea.md'])).toEqual(['projects/idea.md'])
	})

	test('ranks an exact path match highest', () => {
		expect(
			pathsFor('notes/project.md', [
				'notes/project-plan.md',
				'notes/project.md',
				'archive/notes/project.md'
			])[0]
		).toBe('notes/project.md')
	})

	test('prefers basename matches over dirname-only matches for non-path queries', () => {
		expect(
			pathsFor('meeting', [
				'meeting/archive/notes.md',
				'work/meeting-notes.md',
				'archive/team-meeting/summary.md'
			]).slice(0, 2)
		).toEqual(['work/meeting-notes.md', 'meeting/archive/notes.md'])
	})

	test('uses path structure when the query contains separators', () => {
		expect(
			pathsFor('work/meet', [
				'meeting/work-notes.md',
				'work/meeting-notes.md',
				'work/logs/team.md'
			])[0]
		).toBe('work/meeting-notes.md')
	})

	test('prefers compact consecutive matches over scattered ones', () => {
		expect(pathsFor('met', ['work/mega-topic.md', 'work/met.md', 'work/memo-template.md'])[0]).toBe(
			'work/met.md'
		)
	})

	test('prefers separator-boundary matches over mid-word matches', () => {
		expect(
			pathsFor('bar', ['notes/foobar.md', 'notes/foo-bar.md', 'notes/crowbar.md']).slice(0, 2)
		).toEqual(['notes/foo-bar.md', 'notes/foobar.md'])
	})

	test('prefers the shortest exact basename prefix first', () => {
		expect(
			pathsFor('window', ['ui/window-actions.md', 'ui/window.md', 'docs/windowing.md'])[0]
		).toBe('ui/window.md')
	})

	test('prefers shallower paths when other signals are equal', () => {
		expect(
			pathsFor('todo', ['projects/notes/todo.md', 'notes/todo.md', 'work/todo-archive.md']).slice(
				0,
				2
			)
		).toEqual(['notes/todo.md', 'projects/notes/todo.md'])
	})

	test('requires every query term to match somewhere in the path', () => {
		expect(
			pathsFor('proj idea', [
				'projects/ideas/index.md',
				'projects/index.md',
				'ideas/inbox.md',
				'archive/project-idea.md'
			])
		).toEqual(['archive/project-idea.md', 'projects/ideas/index.md'])
	})

	test('filters out inactive entries', () => {
		const items: FuzzyPathItem[] = [
			{
				id: 'inactive',
				path: 'notes/project.md',
				active: 0,
				updated_at: '2026-01-01T00:00:00.000Z'
			},
			{
				id: 'active',
				path: 'notes/project-plan.md',
				active: 1,
				updated_at: '2026-01-02T00:00:00.000Z'
			}
		]

		expect(searchPaths(items, 'project').map((item) => item.id)).toEqual(['active'])
	})
})
