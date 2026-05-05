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
