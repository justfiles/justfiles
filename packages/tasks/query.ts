/**
 * Pure filtering and sectioning over Task[].
 *
 * OVERDUE is computed at read time: status == TODO AND due < today.
 * Sections are ordered overdue → today → upcoming → undated.
 */

import type { Task } from './store.ts'

export type SectionKey = 'overdue' | 'today' | 'upcoming' | 'undated'

export type Sections = Record<SectionKey, Task[]>

export const SECTION_ORDER: SectionKey[] = ['overdue', 'today', 'upcoming', 'undated']

export type FilterOptions = {
	tags?: string[]
	priority?: 1 | 2 | 3
	due?: string
	status?: string
}

export function filterTasks(tasks: Task[], opts: FilterOptions): Task[] {
	let result = tasks
	const tags = opts.tags
	if (tags && tags.length > 0) {
		result = result.filter((t) => tags.every((tag) => t.tags.includes(tag)))
	}
	if (opts.priority !== undefined) {
		result = result.filter((t) => t.priority === opts.priority)
	}
	if (opts.due !== undefined) {
		result = result.filter((t) => t.due === opts.due)
	}
	if (opts.status !== undefined) {
		result = result.filter((t) => t.status === opts.status)
	}
	return result
}

export function groupTasks(tasks: Task[], today: string): Sections {
	const sections: Sections = { overdue: [], today: [], upcoming: [], undated: [] }
	for (const t of tasks) {
		if (!t.due) {
			sections.undated.push(t)
		} else if (t.status === 'TODO' && t.due < today) {
			sections.overdue.push(t)
		} else if (t.due === today) {
			sections.today.push(t)
		} else {
			sections.upcoming.push(t)
		}
	}
	return sections
}
