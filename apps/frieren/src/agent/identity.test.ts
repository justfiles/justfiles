import { AVATAR_PATH, SOUL_PATH } from '@justfiles/agent/defaults'
import { memStorage, volume } from '@justfiles/fs'
import { expect, test } from 'vitest'
import { readAgentSoul, watchIdentity } from './identity'

// The shell no longer writes these files — Settings' Agent pane does, in an app frame,
// and another device does through sync. So it watches them instead of being told, which
// is what makes a rename on the phone show up here.

const encode = (text: string) => new TextEncoder().encode(text)
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function seeded() {
	const vol = volume(memStorage())
	await vol.mkdir('/system/agents/main', { recursive: true })
	await vol.writeFile(
		SOUL_PATH,
		encode(
			'---\nschema: frieren/agent-soul/v1\nagent_name: Kodama\nseeded: true\n---\n\nYou are Kodama.\n'
		)
	)
	return vol
}

test('a soul written by anyone — this device or another — wakes the shell', async () => {
	const vol = await seeded()
	let fired = 0
	const stop = await watchIdentity(vol, () => {
		fired++
	})
	await vol.writeFile(
		SOUL_PATH,
		encode(
			'---\nschema: frieren/agent-soul/v1\nagent_name: Fern\nagent_gender: female\n---\n\nYou are Fern.\n'
		)
	)
	await flush()
	expect(fired).toBeGreaterThan(0)
	// And the read reflects it: the name to greet by, and no longer seeded.
	const soul = await readAgentSoul(vol)
	expect(soul?.frontmatter.agent_name).toBe('Fern')
	expect(soul?.frontmatter.seeded).toBeUndefined()

	// The face is the second half of an identity change.
	const before = fired
	await vol.writeFile(AVATAR_PATH, new Uint8Array([137, 80, 78, 71]))
	await flush()
	expect(fired).toBeGreaterThan(before)

	// And it stops when the provider unmounts.
	stop()
	const after = fired
	await vol.writeFile(AVATAR_PATH, new Uint8Array([1, 2, 3]))
	await flush()
	expect(fired).toBe(after)
})
