import { PROFILE_PATH, SOUL_PATH } from '../../shared/agent-defaults'
import type { Volume } from '../fs'

// The identity files the personalize flow edits. Seeded with defaults at boot
// (see shared/agent-defaults.ts); this UI only overwrites them on demand.
export const PATHS = {
	profile: PROFILE_PATH,
	soul: SOUL_PATH
} as const

const decoder = new TextDecoder()

function parseFrontmatter(text: string): Record<string, string> {
	const match = text.match(/^---\n([\s\S]*?)\n---/)
	if (!match) return {}
	const out: Record<string, string> = {}
	for (const line of match[1].split('\n')) {
		const idx = line.indexOf(':')
		if (idx === -1) continue
		const key = line.slice(0, idx).trim()
		const value = line.slice(idx + 1).trim()
		if (key) out[key] = value
	}
	return out
}

export async function readUserProfile(volume: Volume): Promise<Record<string, string> | null> {
	if (!(await volume.exists(PATHS.profile))) return null
	const text = decoder.decode(await volume.readFile(PATHS.profile))
	return parseFrontmatter(text)
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
