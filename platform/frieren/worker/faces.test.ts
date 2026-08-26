import { volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { describe, expect, test, vi } from 'vitest'
import { generateFace } from './faces'

// A real PNG signature, because the engine's mime is now read from the BYTES and not from the
// file's name — art that does not identify itself is art we do not send to an image model.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
// The avatar the faces are derived from: a DIRECTORY, and the state it rests in is the seed.
// `resting.webp` in the same place would resolve identically — the reader matches the stem.
const MINE = '/system/agents/main/avatars/mine'
// The hash of PNG under avatarFaceHash — resolved once, lazily, so the test states the
// contract ("the caller's hash must match the resting art") rather than a magic constant.
async function setup(options: { avatar?: Uint8Array } = {}) {
	const { avatarFaceHash } = await import('@justfiles/agent/defaults')
	const vol = volume(memStore())
	if (options.avatar !== null) {
		await vol.mkdir(MINE, { recursive: true })
		await vol.writeFile(`${MINE}/resting.png`, options.avatar ?? PNG)
	}
	const store = new Map<string, unknown>()
	const storage = {
		get: async <T>(key: string) => store.get(key) as T | undefined,
		put: async <T>(key: string, value: T) => void store.set(key, value),
		delete: async (key: string) => store.delete(key)
	}
	return {
		vol,
		storage,
		store,
		hash: await avatarFaceHash(PNG),
		inFlight: new Map<string, Promise<{ data: string; mimeType: string } | null>>()
	}
}

const image = { data: 'aGk=', mimeType: 'image/png' }

describe('generateFace', () => {
	test('edits the resting art and hands back the face with its hash', async () => {
		const { vol, storage, hash, inFlight } = await setup()
		const generate = vi.fn().mockResolvedValue([image])

		const face = await generateFace(
			{ volume: vol, storage, generate, inFlight },
			'mine',
			'pleased',
			hash
		)

		expect(face).toEqual({ ...image, hash })
		// The resting art rides along as an image — this is an edit, not a fresh draw.
		const [prompt, source] = generate.mock.calls[0]
		expect(prompt).toContain('pleased')
		expect(source.mimeType).toBe('image/png')
	})

	test('a stale hash is refused without spending an image', async () => {
		const { vol, storage, inFlight } = await setup()
		const generate = vi.fn().mockResolvedValue([image])

		expect(
			await generateFace(
				{ volume: vol, storage, generate, inFlight },
				'mine',
				'pleased',
				'deadbeef'
			)
		).toBeNull()
		expect(generate).not.toHaveBeenCalled()
	})

	test('with no engine, or no such avatar, it is simply null', async () => {
		const withEngine = await setup()
		expect(
			await generateFace(
				{ volume: withEngine.vol, storage: withEngine.storage, inFlight: withEngine.inFlight },
				'mine',
				'pleased',
				withEngine.hash
			)
		).toBeNull()

		const bare = volume(memStore())
		expect(
			await generateFace(
				{
					volume: bare,
					storage: withEngine.storage,
					generate: vi.fn(),
					inFlight: withEngine.inFlight
				},
				'mine',
				'pleased',
				withEngine.hash
			)
		).toBeNull()
	})

	test('concurrent asks for one face share a single generation', async () => {
		const { vol, storage, hash, inFlight } = await setup()
		const generate = vi.fn().mockResolvedValue([image])
		const deps = { volume: vol, storage, generate, inFlight }

		const [a, b] = await Promise.all([
			generateFace(deps, 'mine', 'pleased', hash),
			generateFace(deps, 'mine', 'pleased', hash)
		])

		expect(generate).toHaveBeenCalledTimes(1)
		expect(a).toEqual(b)
	})

	test('a refusal backs off for a day, then retries', async () => {
		const { vol, storage, hash, inFlight } = await setup()
		const generate = vi.fn().mockRejectedValue(new Error('refused'))
		let now = 1_000_000
		const deps = { volume: vol, storage, generate, inFlight, now: () => now }

		expect(await generateFace(deps, 'mine', 'pleased', hash)).toBeNull()
		expect(await generateFace(deps, 'mine', 'pleased', hash)).toBeNull()
		expect(generate).toHaveBeenCalledTimes(1)

		// A different expression is unaffected by the failed one.
		await generateFace(deps, 'mine', 'concerned', hash)
		expect(generate).toHaveBeenCalledTimes(2)

		now += 25 * 60 * 60 * 1000
		generate.mockResolvedValue([image])
		expect(await generateFace(deps, 'mine', 'pleased', hash)).toEqual({ ...image, hash })
	})

	test('a spent AI cap is a null, not a throw', async () => {
		const { vol, storage, hash, inFlight } = await setup()
		const generate = vi.fn().mockRejectedValue(new Error('weekly AI limit reached'))

		await expect(
			generateFace({ volume: vol, storage, generate, inFlight }, 'mine', 'pleased', hash)
		).resolves.toBeNull()
	})
})
