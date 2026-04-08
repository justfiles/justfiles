import { basename, normalizeVolumePath, parentVolumePath } from './assets'

const MARKDOWN_EXTENSION = '.md'

export function stripMarkdownExtension(value: string): string {
	return value.toLowerCase().endsWith(MARKDOWN_EXTENSION)
		? value.slice(0, -MARKDOWN_EXTENSION.length)
		: value
}

function sanitizeNoteSegment(raw: string): string {
	return raw.replace(/\s+/g, ' ').trim()
}

export function sanitizeNoteName(raw: string): string {
	const collapsed = sanitizeNoteSegment(raw.replace(/[\\/]+/g, ' '))

	return stripMarkdownExtension(collapsed) || 'untitled'
}

export function sanitizeNotePath(raw: string): string {
	const input = raw.replace(/\\/g, '/')
	const rawSegments = input.split('/')
	const segments = rawSegments
		.map((segment, index) => {
			const sanitized = sanitizeNoteSegment(segment)
			if (!sanitized || sanitized === '.' || sanitized === '..') return ''
			return index === rawSegments.length - 1 ? stripMarkdownExtension(sanitized) : sanitized
		})
		.filter(Boolean)

	if (segments.length === 0) return 'untitled'
	return segments.join('/')
}

export function noteFilenameFromName(raw: string): string {
	return `${sanitizeNoteName(raw)}${MARKDOWN_EXTENSION}`
}

export function noteFilenameFromPath(path: string): string {
	return basename(path) || noteFilenameFromName('untitled')
}

export function noteNameFromPath(path: string): string {
	return stripMarkdownExtension(noteFilenameFromPath(path))
}

export function notePathWithName(path: string, rawName: string): string {
	const parent = parentVolumePath(path)
	const relativePath = sanitizeNotePath(rawName)
	const segments = relativePath.split('/').filter(Boolean)
	const name = segments.pop() || 'untitled'
	return normalizeVolumePath(`${parent}/${[...segments, noteFilenameFromName(name)].join('/')}`)
}
