import { basename, normalizeVolumePath, parentVolumePath } from './assets'

const MARKDOWN_EXTENSION = '.md'

export function stripMarkdownExtension(value: string): string {
	return value.toLowerCase().endsWith(MARKDOWN_EXTENSION)
		? value.slice(0, -MARKDOWN_EXTENSION.length)
		: value
}

export function sanitizeNoteName(raw: string): string {
	const collapsed = raw
		.replace(/[\\/]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()

	return stripMarkdownExtension(collapsed) || 'untitled'
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
	return normalizeVolumePath(`${parent}/${noteFilenameFromName(rawName)}`)
}
