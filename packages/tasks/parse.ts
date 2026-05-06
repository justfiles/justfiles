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

export type Recur = {
	type: 'catchup' | 'restart' | 'fixed'
	interval: string
}

export type TaskMeta = {
	id: string
	status: string
	due?: string
	title: string
	tags: string[]
	priority?: 1 | 2 | 3
	recur?: Recur
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
	const tags = (meta.tags ?? []).map((t) => `__${t}`).join('')
	const priority = meta.priority ? `__p${meta.priority}` : ''
	const recurToken = meta.recur
		? `__${meta.recur.type === 'catchup' ? 'r' : meta.recur.type === 'restart' ? 'rs' : 'rf'}-${meta.recur.interval}`
		: ''
	const dueSegment = meta.due ? `--${meta.due}` : ''
	return `${meta.id}--${meta.status}${dueSegment}--${title}${tags}${priority}${recurToken}.md`
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

	const titleSegment = titleParts.join('--')
	if (titleSegment.length === 0) return null

	const [titleSlug, ...tokens] = titleSegment.split('__')
	if (!titleSlug) return null

	const tags: string[] = []
	let priority: 1 | 2 | 3 | undefined
	let recur: Recur | undefined
	for (const token of tokens) {
		if (token === 'p1') priority = 1
		else if (token === 'p2') priority = 2
		else if (token === 'p3') priority = 3
		else if (/^r-(.+)$/.test(token)) recur = { type: 'catchup', interval: token.slice(2) }
		else if (/^rs-(.+)$/.test(token)) recur = { type: 'restart', interval: token.slice(3) }
		else if (/^rf-(.+)$/.test(token)) recur = { type: 'fixed', interval: token.slice(3) }
		else if (token.length > 0) tags.push(token)
	}

	const result: TaskMeta = { id, status, title: titleSlug, tags }
	if (due) result.due = due
	if (priority) result.priority = priority
	if (recur) result.recur = recur
	return result
}
