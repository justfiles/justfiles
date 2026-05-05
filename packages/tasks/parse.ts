/**
 * Filename encoding for tasks.
 *
 * Format: {ID}--{status}[--{due}]--{title}.md
 *
 * - ID: YYYYMMDDTHHMMSS, optionally suffixed with -N for collision avoidance
 * - Status: TODO | DONE | <other> (open string)
 * - Due (optional): YYYYMMDD; detected by the \d{8} pattern
 * - Title: hyphen-slugified from the original; bare 8-digit slugs are
 *   prefixed with `task-` to avoid being misparsed as a due date
 */

export type TaskMeta = {
	id: string
	status: string
	due?: string
	title: string
}

const ID_PATTERN = /^\d{8}T\d{6}(?:-\d+)?$/
const DUE_PATTERN = /^\d{8}$/

export function slugify(input: string): string {
	const slug = input
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^\p{Letter}\p{Number}]+/gu, '-')
		.replace(/^-+|-+$/g, '')
	if (!slug) return 'untitled'
	if (DUE_PATTERN.test(slug)) return `task-${slug}`
	return slug
}

export function isValidId(id: string): boolean {
	return ID_PATTERN.test(id)
}

export function isValidDue(due: string): boolean {
	return DUE_PATTERN.test(due)
}

export function encodeFilename(meta: TaskMeta): string {
	if (!isValidId(meta.id)) {
		throw new Error(`invalid task id: ${meta.id}`)
	}
	if (meta.due !== undefined && !isValidDue(meta.due)) {
		throw new Error(`invalid due date: ${meta.due}`)
	}
	const title = slugify(meta.title)
	const dueSegment = meta.due ? `--${meta.due}` : ''
	return `${meta.id}--${meta.status}${dueSegment}--${title}.md`
}

export function decodeFilename(filename: string): TaskMeta | null {
	if (!filename.endsWith('.md')) return null
	const stem = filename.slice(0, -3)
	const parts = stem.split('--')
	if (parts.length < 3) return null

	const [id, status, ...rest] = parts
	if (id === undefined || status === undefined) return null
	if (!isValidId(id)) return null
	if (status.length === 0) return null

	let due: string | undefined
	let titleParts = rest
	if (rest.length >= 2 && rest[0] !== undefined && DUE_PATTERN.test(rest[0])) {
		due = rest[0]
		titleParts = rest.slice(1)
	}

	const title = titleParts.join('--')
	if (title.length === 0) return null

	return due ? { id, status, due, title } : { id, status, title }
}
