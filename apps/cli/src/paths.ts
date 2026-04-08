import { posix } from 'node:path'

export function normalizeVolumePath(input: string): string {
	const trimmed = input.trim()
	if (!trimmed) throw new Error('EINVAL: path must not be empty')
	if (!trimmed.startsWith('/')) {
		throw new Error(`EINVAL: paths must be absolute within a volume: ${trimmed}`)
	}

	const normalized = posix.normalize(trimmed)
	return normalized.startsWith('/') ? normalized : `/${normalized}`
}

export function basenameVolumePath(path: string): string {
	return posix.basename(path)
}

export function parentVolumePath(path: string): string {
	return posix.dirname(path)
}

export function joinVolumePath(parent: string, name: string): string {
	return parent === '/' ? `/${name}` : `${parent}/${name}`
}
