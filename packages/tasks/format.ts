import { SECTION_ORDER, type Sections } from './query.ts'
import type { Task } from './store.ts'

function filename(path: string): string {
	return path.split('/').pop() ?? path
}

function bullet(task: Task & { source?: string }): string {
	const priority = task.priority ? `[p${task.priority}] ` : ''
	const source = task.source ? ` [${task.source}]` : ''
	return `- [${task.id}] ${priority}${task.title}${source}`
}

export function formatMarkdown(tasks: (Task & { source?: string })[]): string {
	if (tasks.length === 0) return 'No tasks.\n'
	return `${tasks.map(bullet).join('\n')}\n`
}

export function formatJson(tasks: (Task & { source?: string })[]): string {
	return `${JSON.stringify(tasks, null, 2)}\n`
}

export function formatIds(tasks: (Task & { source?: string })[]): string {
	return tasks.map((task) => (task.source ? task.path : filename(task.path))).join('\n')
}

export function formatSections(sections: Sections): string {
	const nonEmpty = SECTION_ORDER.filter((k) => sections[k].length > 0)
	if (nonEmpty.length === 0) return 'No tasks.\n'
	if (nonEmpty.length === 1) {
		const key = nonEmpty[0]
		if (key === undefined) return 'No tasks.\n'
		return `${sections[key].map(bullet).join('\n')}\n`
	}
	return `${nonEmpty.map((k) => `# ${k}\n\n${sections[k].map(bullet).join('\n')}`).join('\n\n')}\n`
}
