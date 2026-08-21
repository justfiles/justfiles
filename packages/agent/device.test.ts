import { volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { describe, expect, test } from 'vitest'
import { deviceId } from './device.ts'

// The claim/race behaviour itself is pinned in @justfiles/fs's persistedState.test.ts —
// device.ts delegates to it entirely. A BARE `memStore()` on purpose: every backend now
// claims a name atomically with no condition attached, so the convergence tests below
// exercise the real claim rather than volume.ts's non-atomic fallback.
const storage = () => memStore()

describe('deviceId', () => {
	test('first call creates /private/state/clientid and returns 8 lowercase hex chars', async () => {
		const vol = volume(storage())
		const id = await deviceId(vol)
		expect(id).toMatch(/^[a-f0-9]{8}$/)
		expect(await vol.exists('/private/state/clientid')).toBe(true)
	})

	test('second call is memoised and does not rewrite the file', async () => {
		const vol = volume(storage())
		const first = await deviceId(vol)
		const before = await vol.readFile('/private/state/clientid')
		const second = await deviceId(vol)
		const after = await vol.readFile('/private/state/clientid')
		expect(second).toBe(first)
		expect(after).toEqual(before)
	})

	test('a new accessor over the same volume returns the same value', async () => {
		const backing = storage()
		const first = await deviceId(volume(backing))
		const second = await deviceId(volume(backing))
		expect(second).toBe(first)
	})

	test('two different volumes yield different ids', async () => {
		const a = await deviceId(volume(storage()))
		const b = await deviceId(volume(storage()))
		expect(a).not.toBe(b)
	})

	test('derives from an existing clientid without rewriting it', async () => {
		const backing = storage()
		const vol = volume(backing)
		const uuid = crypto.randomUUID()
		await vol.mkdir('/private/state', { recursive: true })
		await vol.writeFile('/private/state/clientid', new TextEncoder().encode(JSON.stringify(uuid)))
		const before = await vol.readFile('/private/state/clientid')

		const id = await deviceId(vol)

		expect(id).toBe(uuid.replace(/-/g, '').slice(0, 8))
		const after = await vol.readFile('/private/state/clientid')
		expect(after).toEqual(before)
		expect(JSON.parse(new TextDecoder().decode(after))).toBe(uuid)
	})

	test('filename-safe', async () => {
		const id = await deviceId(volume(storage()))
		expect(id).toMatch(/^[a-z0-9]+$/)
	})

	test('two Volume wrappers over the same storage racing to mint converge on one id', async () => {
		const backing = storage()
		const [a, b] = await Promise.all([deviceId(volume(backing)), deviceId(volume(backing))])
		expect(a).toBe(b)
		// Exactly one clientid file, holding the winner — no overwrite, no divergence.
		const raw = JSON.parse(
			new TextDecoder().decode(await volume(backing).readFile('/private/state/clientid'))
		)
		expect(raw.replace(/-/g, '').slice(0, 8)).toBe(a)
	})

	test('concurrency: two parallel first-calls on the same volume resolve to the same id', async () => {
		const vol = volume(storage())
		const [a, b] = await Promise.all([deviceId(vol), deviceId(vol)])
		expect(a).toBe(b)
	})
})
