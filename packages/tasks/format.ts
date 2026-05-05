import type { Task } from './store.ts'

export function formatMarkdown(tasks: Task[]): string {
	if (tasks.length === 0) return 'No tasks.\n'
	return `${tasks.map((t) => `- [${t.id}] ${t.title}`).join('\n')}\n`
}
