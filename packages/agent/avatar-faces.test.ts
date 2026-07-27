import { describe, expect, test } from 'vitest'
import { avatarFaceHash, avatarFacePath, parseAvatarFaceName } from './agent-defaults.ts'

describe('avatar faces', () => {
	test('a face path round-trips through its name', async () => {
		const hash = await avatarFaceHash(new Uint8Array([1, 2, 3]))
		const path = avatarFacePath('pleased', hash)
		expect(path).toBe(`/system/agents/main/avatar-pleased@${hash}.png`)
		expect(parseAvatarFaceName(path.split('/').pop() ?? '')).toEqual({
			expression: 'pleased',
			hash
		})
	})

	test('the hash is stable, short, and changes with the bytes', async () => {
		const a = await avatarFaceHash(new Uint8Array([1, 2, 3]))
		const b = await avatarFaceHash(new Uint8Array([1, 2, 3]))
		const c = await avatarFaceHash(new Uint8Array([1, 2, 4]))
		expect(a).toBe(b)
		expect(a).not.toBe(c)
		expect(a).toMatch(/^[0-9a-f]{8}$/)
	})

	test('only face names parse', () => {
		expect(parseAvatarFaceName('avatar.png')).toBeNull()
		expect(parseAvatarFaceName('soul.md')).toBeNull()
		expect(parseAvatarFaceName('avatar-pleased.png')).toBeNull()
	})
})
