import type { Volume } from '../fs'

export const PATHS = {
	profile: '/system/profiles/user.md',
	soul: '/system/soul.md'
} as const

export type OnboardingState = 'user' | 'agent' | 'done'

export async function resolveOnboardingState(volume: Volume): Promise<OnboardingState> {
	const hasProfile = await volume.exists(PATHS.profile)
	if (!hasProfile) return 'user'
	const hasSoul = await volume.exists(PATHS.soul)
	if (!hasSoul) return 'agent'
	return 'done'
}

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
