import { volume } from '@justfiles/fs'
import { memStorage } from '@justfiles/fs/storage/mem'
import { describe, expect, test } from 'vitest'
import { deviceId } from './device.ts'

describe('deviceId', () => {
	test('first call creates /.state/clientid and returns 8 lowercase hex chars', async () => {
		const vol = volume(memStorage())
		const id = await deviceId(vol)
		expect(id).toMatch(/^[a-f0-9]{8}$/)
		expect(await vol.exists('/.state/clientid')).toBe(true)
	})

	test('second call is memoised and does not rewrite the file', async () => {
		const vol = volume(memStorage())
		const first = await deviceId(vol)
		const before = await vol.readFile('/.state/clientid')
		const second = await deviceId(vol)
		const after = await vol.readFile('/.state/clientid')
		expect(second).toBe(first)
		expect(after).toEqual(before)
	})

	test('a new accessor over the same volume returns the same value', async () => {
		const storage = memStorage()
		const first = await deviceId(volume(storage))
		const second = await deviceId(volume(storage))
		expect(second).toBe(first)
	})

	test('two different volumes yield different ids', async () => {
		const a = await deviceId(volume(memStorage()))
		const b = await deviceId(volume(memStorage()))
		expect(a).not.toBe(b)
	})

	test('interop with synced(): derives from an existing clientid without rewriting it', async () => {
		const storage = memStorage()
		const vol = volume(storage)
		const uuid = crypto.randomUUID()
		await vol.mkdir('/.state', { recursive: true })
		await vol.writeFile('/.state/clientid', new TextEncoder().encode(JSON.stringify(uuid)))
		const before = await vol.readFile('/.state/clientid')

		const id = await deviceId(vol)

		expect(id).toBe(uuid.replace(/-/g, '').slice(0, 8))
		const after = await vol.readFile('/.state/clientid')
		expect(after).toEqual(before)
		// The sync layer's own reader (JSON-decode) still parses it.
		expect(JSON.parse(new TextDecoder().decode(after))).toBe(uuid)
	})

	test('filename-safe', async () => {
		const id = await deviceId(volume(memStorage()))
		expect(id).toMatch(/^[a-z0-9]+$/)
	})

	test('concurrency: two parallel first-calls resolve to the same id and write once', async () => {
		const storage = memStorage()
		let writes = 0
		const tracked = {
			...storage,
			putBlob: (...args: Parameters<typeof storage.putBlob>) => {
				writes++
				return storage.putBlob(...args)
			}
		}
		const vol = volume(tracked)
		const [a, b] = await Promise.all([deviceId(vol), deviceId(vol)])
		expect(a).toBe(b)
		expect(writes).toBe(1)
	})
})
