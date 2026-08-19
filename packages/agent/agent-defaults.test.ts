import { volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { expect, test, vi } from 'vitest'
import {
	DEFAULT_AGENT_NAME,
	DEFAULT_PROFILE,
	DEFAULT_SOUL,
	PROFILE_PATH,
	readAgentName,
	readProfile,
	readSoul,
	SOUL_PATH
} from './agent-defaults.ts'

const bytes = (value: string) => new TextEncoder().encode(value)

async function write(vol: ReturnType<typeof volume>, path: string, text: string) {
	await vol.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true })
	await vol.writeFile(path, bytes(text))
}

test('an empty volume reads as the built-in identity', async () => {
	const fs = volume(memStore())

	expect(await readSoul(fs)).toBe(DEFAULT_SOUL)
	expect(await readProfile(fs)).toBe(DEFAULT_PROFILE)
	expect(await readAgentName(fs)).toBe(DEFAULT_AGENT_NAME)
})

// The point of the whole slice: an adopt-mine republish must have no competing writer, so
// READING the identity of a volume that has none may not create one.
test('reading identity writes nothing', async () => {
	const fs = volume(memStore())
	const write = vi.spyOn(fs, 'writeFile')
	const mkdir = vi.spyOn(fs, 'mkdir')

	await Promise.all([readSoul(fs), readProfile(fs), readAgentName(fs)])

	expect(write).not.toHaveBeenCalled()
	expect(mkdir).not.toHaveBeenCalled()
	expect(await fs.exists(SOUL_PATH)).toBe(false)
	expect(await fs.exists(PROFILE_PATH)).toBe(false)
})

test('one file present defaults only the other', async () => {
	const fs = volume(memStore())
	await write(fs, SOUL_PATH, '---\nagent_name: Fern\n---\n\nYou are Fern.')

	expect(await readAgentName(fs)).toBe('Fern')
	expect(await readSoul(fs)).toContain('You are Fern.')
	expect(await readProfile(fs)).toBe(DEFAULT_PROFILE)
})

test('an explicit file is authoritative and reloads unchanged', async () => {
	const storage = memStore()
	await write(volume(storage), PROFILE_PATH, '---\nname: Stark\n---\n')

	// A fresh Volume over the same storage is what a restarted host sees.
	expect(await readProfile(volume(storage))).toBe('---\nname: Stark\n---\n')
})

test('a soul with no agent_name falls back to the built-in name', async () => {
	const fs = volume(memStore())
	await write(fs, SOUL_PATH, '---\nseeded: true\n---\n\nagent_name: not frontmatter')

	expect(await readAgentName(fs)).toBe(DEFAULT_AGENT_NAME)
})
