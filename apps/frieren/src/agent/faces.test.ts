import { avatarDir } from '@justfiles/agent/defaults'
import { memStorage, volume } from '@justfiles/fs'
import { beforeEach, expect, test, vi } from 'vitest'
import { requestFace } from './faces'
import { derivedDir, readAvatar } from './identity'

// The generated set is housekept HERE, by the write that replaces it — there is no daily
// sweep and no filename grammar any more. Canvas is the browser's, so the downscale is
// stubbed: what this covers is where the bytes land and what they displace.
vi.mock('./squarePng', () => ({ squarePng: async () => new Uint8Array([9, 9]) }))

const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3])
const MINE = avatarDir('mine')
const token = async () => 'token'

beforeEach(() => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: string, init: { body: string }) => {
			const { hash } = JSON.parse(init.body) as { hash: string }
			return {
				ok: true,
				json: async () => ({ data: 'aGk=', mimeType: 'image/png', hash })
			}
		})
	)
})

async function wearing() {
	const vol = volume(memStorage())
	await vol.mkdir(MINE, { recursive: true })
	await vol.writeFile(`${MINE}/resting.png`, PNG)
	// Someone drew this one: it must survive every generation, forever.
	await vol.writeFile(`${MINE}/apologetic.png`, new Uint8Array([1]))
	const { hash } = await readAvatar(vol, 'mine')
	if (!hash) throw new Error('an avatar on the volume must have a hash')
	return { vol, hash }
}

test('a derived face lands under the resting art it was derived from', async () => {
	const { vol, hash } = await wearing()
	expect(await requestFace(vol, token, 'mine', 'pleased', hash)).toBe(true)
	expect(await vol.exists(`${derivedDir('mine', hash)}/pleased.png`)).toBe(true)
	// The avatar's own directory holds only authored art — this wrote nothing into it.
	expect((await vol.readdir(MINE)).map((e) => e.name).sort()).toEqual([
		'.gen',
		'apologetic.png',
		'resting.png'
	])
})

test('writing a new set collects the previous one, and never anything authored', async () => {
	const { vol, hash } = await wearing()
	// Art derived from a resting file that has since been replaced.
	await vol.mkdir(derivedDir('mine', 'deadbeef'), { recursive: true })
	await vol.writeFile(`${derivedDir('mine', 'deadbeef')}/curious.png`, new Uint8Array([2]))
	// And a second avatar, which this must not touch either.
	await vol.mkdir(`${avatarDir('aurora')}/.gen/cafe`, { recursive: true })

	expect(await requestFace(vol, token, 'mine', 'pleased', hash)).toBe(true)

	expect(await vol.exists(derivedDir('mine', 'deadbeef'))).toBe(false)
	expect(await vol.exists(derivedDir('mine', hash))).toBe(true)
	expect(await vol.exists(`${MINE}/apologetic.png`)).toBe(true)
	expect(await vol.exists(`${avatarDir('aurora')}/.gen/cafe`)).toBe(true)
})

test('a stale answer is dropped rather than stored under the wrong art', async () => {
	const { vol } = await wearing()
	// The worker answers about the hash it was ASKED for; the client only keeps an answer
	// that matches the resting file it is looking at.
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => ({ ok: true, json: async () => ({ skipped: true }) }))
	)
	expect(await requestFace(vol, token, 'mine', 'pleased', 'deadbeef')).toBe(false)
	expect(await vol.exists(`${MINE}/.gen`)).toBe(false)
})
