/**
 * Filename encoding for tasks (walking-skeleton subset).
 *
 * Format: {ID}--{status}--{title}.md
 *
 * - ID: YYYYMMDDTHHMMSS, optionally suffixed with -N for collision avoidance
 * - Status: TODO | DONE | <other> (open string)
 * - Title: hyphen-slugified from the original
 */

export type TaskMeta = {
	id: string
	status: string
	title: string
}

const ID_PATTERN = /^\d{8}T\d{6}(?:-\d+)?$/

export function slugify(input: string): string {
	const slug = input
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^\p{Letter}\p{Number}]+/gu, '-')
		.replace(/^-+|-+$/g, '')
	return slug || 'untitled'
}

export function isValidId(id: string): boolean {
	return ID_PATTERN.test(id)
}

export function encodeFilename(meta: TaskMeta): string {
	if (!isValidId(meta.id)) {
		throw new Error(`invalid task id: ${meta.id}`)
	}
	const title = slugify(meta.title)
	return `${meta.id}--${meta.status}--${title}.md`
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

	const title = rest.join('--')
	if (title.length === 0) return null

	return { id, status, title }
}
