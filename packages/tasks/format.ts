import { SECTION_ORDER, type Sections } from './query.ts'
import type { Task } from './store.ts'

function bullet(task: Task): string {
	return `- [${task.id}] ${task.title}`
}

export function formatMarkdown(tasks: Task[]): string {
	if (tasks.length === 0) return 'No tasks.\n'
	return `${tasks.map(bullet).join('\n')}\n`
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
