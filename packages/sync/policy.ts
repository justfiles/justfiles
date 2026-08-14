export class IgnorePolicyError extends Error {
	constructor(readonly root: string) {
		super(`invalid ignore root: ${JSON.stringify(root)}`)
		this.name = 'IgnorePolicyError'
	}
}

export type IgnorePolicy = {
	readonly roots: readonly string[]
	readonly hash: string
	ignored(path: string): boolean
}

export function normalizeIgnore(input: readonly string[] = []): readonly string[] {
	const candidates = new Set<string>()
	for (const raw of input) {
		if (!raw.startsWith('/') || raw.includes('\0')) throw new IgnorePolicyError(raw)
		const trimmed = raw.replace(/\/+$/, '')
		if (!trimmed) throw new IgnorePolicyError(raw)
		const parts = trimmed.slice(1).split('/')
		if (parts.some((part) => !part || part === '.' || part === '..'))
			throw new IgnorePolicyError(raw)
		candidates.add(`/${parts.map((part) => part.normalize('NFC')).join('/')}`)
	}

	const roots: string[] = []
	for (const root of [...candidates].sort())
		if (!roots.some((parent) => root.startsWith(`${parent}/`))) roots.push(root)
	return roots
}

export function ignoredPath(roots: readonly string[], path: string): boolean {
	const candidate = path.normalize('NFC')
	return roots.some((root) => candidate === root || candidate.startsWith(`${root}/`))
}

export async function hashIgnore(roots: readonly string[]): Promise<string> {
	const data = new TextEncoder().encode(JSON.stringify(roots))
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
	return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function ignorePolicy(input: readonly string[] = []): Promise<IgnorePolicy> {
	const roots = normalizeIgnore(input)
	const hash = await hashIgnore(roots)
	return {
		roots,
		hash,
		ignored: (path) => ignoredPath(roots, path)
	}
}
