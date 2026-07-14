import { memStorage, volume } from '@justfiles/fs'
import { expect, test } from 'vitest'
import { ensureAgentDefaults, PROFILE_PATH, SOUL_PATH } from './agent-defaults'

// Regression: after a `wipe` the server volume is empty, so `/system` does not
// exist. `ensureAgentDefaults` must create the parent dir before writing the
// profile — otherwise `writeFile` throws `ENOENT: /system` (the reset 500).
test('seeds defaults into an empty volume (post-wipe)', async () => {
	const fs = volume(memStorage())
	await ensureAgentDefaults(fs)
	expect(await fs.exists(PROFILE_PATH)).toBe(true)
	expect(await fs.exists(SOUL_PATH)).toBe(true)
})

test('is idempotent and never overwrites a personalized soul', async () => {
	const fs = volume(memStorage())
	await fs.mkdir('/system/agents/main', { recursive: true })
	await fs.writeFile(SOUL_PATH, new TextEncoder().encode('custom persona'))
	await ensureAgentDefaults(fs)
	expect(new TextDecoder().decode(await fs.readFile(SOUL_PATH))).toBe('custom persona')
})
