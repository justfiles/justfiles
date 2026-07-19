import { volume } from '@justfiles/fs'
import { memStorage } from '@justfiles/fs/storage/mem'
import { describe, expect, test } from 'vitest'
import { ensureAgentDefaults, PROFILE_PATH, SOUL_PATH } from './agent-defaults.ts'

// `/system` may not exist yet (fresh/wiped volume); `ensureAgentDefaults` must create the
// parent dir before writing, and must never clobber a personalized file.
describe('ensureAgentDefaults', () => {
	test('seeds soul + profile when absent', async () => {
		const fs = volume(memStorage())
		await ensureAgentDefaults(fs)
		expect(await fs.exists(PROFILE_PATH)).toBe(true)
		expect(await fs.exists(SOUL_PATH)).toBe(true)
	})

	test('never overwrites a personalized file', async () => {
		const fs = volume(memStorage())
		await fs.mkdir('/system/agents/main', { recursive: true })
		await fs.writeFile(SOUL_PATH, new TextEncoder().encode('custom persona'))
		await ensureAgentDefaults(fs)
		expect(new TextDecoder().decode(await fs.readFile(SOUL_PATH))).toBe('custom persona')
	})
})
