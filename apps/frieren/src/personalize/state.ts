import { AVATAR_PATH, avatarFacePath, PROFILE_PATH, SOUL_PATH } from '@justfiles/agent/defaults'
import { EXPRESSIONS, type Expression } from '@justfiles/agent/expression'
import type { Volume } from '../fs'

// The identity files the personalize flow edits. Seeded with defaults at boot
// (see @justfiles/agent/defaults); this UI only overwrites them on demand.
export const PATHS = {
	profile: PROFILE_PATH,
	soul: SOUL_PATH,
	avatar: AVATAR_PATH
} as const

export type IdentityFile = {
	frontmatter: Record<string, string>
	body: string
}

const decoder = new TextDecoder()

export function parseIdentityFile(text: string): IdentityFile {
	const match = text.match(/^---\n([\s\S]*?)\n---(?:\n+([\s\S]*))?$/)
	if (!match) return { frontmatter: {}, body: text.trim() }
	const frontmatter: Record<string, string> = {}
	for (const line of match[1].split('\n')) {
		const idx = line.indexOf(':')
		if (idx === -1) continue
		const key = line.slice(0, idx).trim()
		const value = line.slice(idx + 1).trim()
		if (key) frontmatter[key] = value
	}
	return { frontmatter, body: (match[2] ?? '').trim() }
}

async function readIdentityFile(volume: Volume, path: string): Promise<IdentityFile | null> {
	if (!(await volume.exists(path))) return null
	return parseIdentityFile(decoder.decode(await volume.readFile(path)))
}

export async function readUserProfile(volume: Volume): Promise<Record<string, string> | null> {
	return (await readIdentityFile(volume, PATHS.profile))?.frontmatter ?? null
}

export async function readAgentSoul(volume: Volume): Promise<IdentityFile | null> {
	return readIdentityFile(volume, PATHS.soul)
}

/** The chosen face as a data URL, or null while still on the bundled default. */
export async function readAvatarUrl(volume: Volume): Promise<string | null> {
	return readPngDataUrl(volume, PATHS.avatar)
}

/**
 * Per-expression faces that actually exist on the volume. Optional by design: a user's
 * uploaded photo has none, so the avatar just stays on the base image.
 */
export async function readAvatarFaces(
	volume: Volume
): Promise<Partial<Record<Expression, string>>> {
	const faces: Partial<Record<Expression, string>> = {}
	for (const expression of EXPRESSIONS) {
		const url = await readPngDataUrl(volume, avatarFacePath(expression)).catch(() => null)
		if (url) faces[expression] = url
	}
	return faces
}

async function readPngDataUrl(volume: Volume, path: string): Promise<string | null> {
	if (!(await volume.exists(path))) return null
	const bytes = await volume.readFile(path)
	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		reader.onload = () => resolve(String(reader.result))
		reader.onerror = () => reject(reader.error)
		reader.readAsDataURL(new Blob([bytes as BlobPart], { type: 'image/png' }))
	})
}

export function deriveAge(birthDate?: string): number | undefined {
	if (!birthDate) return undefined
	const birth = new Date(birthDate)
	if (Number.isNaN(birth.getTime())) return undefined
	const now = new Date()
	let age = now.getFullYear() - birth.getFullYear()
	const monthDiff = now.getMonth() - birth.getMonth()
	if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < birth.getDate())) age -= 1
	return age
}
