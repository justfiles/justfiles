import { memStorage, volume } from '@justfiles/fs'
import { describe, expect, test } from 'vitest'
import { type Connection, type SecretCodec, volumeConnectionStore } from './connection.ts'

const connection = (over: Partial<Connection> = {}): Connection => ({
	id: 'u@openai.com',
	kind: 'chatgpt',
	creds: { access: 'tok', refresh: 'ref' },
	...over
})

describe('volumeConnectionStore', () => {
	test('round-trips connections and lists them; delete removes one', async () => {
		const store = volumeConnectionStore(volume(memStorage()))
		expect(await store.list()).toEqual([])

		const c = connection({ scopes: ['openid'] })
		await store.put(c)
		expect(await store.get('u@openai.com')).toEqual(c)
		expect(await store.list()).toEqual([c])

		await store.delete('u@openai.com')
		expect(await store.get('u@openai.com')).toBeUndefined()
		expect(await store.list()).toEqual([])
	})

	test('get is undefined for an unknown connection', async () => {
		const store = volumeConnectionStore(volume(memStorage()))
		expect(await store.get('nobody')).toBeUndefined()
	})

	test('secretCodec transforms only the creds lane on disk; reads decode it back', async () => {
		const fs = volume(memStorage())
		const codec: SecretCodec = {
			encode: (creds) => ({ sealed: JSON.stringify(creds) }),
			decode: (raw) => JSON.parse((raw as { sealed: string }).sealed)
		}
		const store = volumeConnectionStore(fs, { secretCodec: codec })
		const c = connection()
		await store.put(c)

		const onDisk = JSON.parse(
			new TextDecoder().decode(await fs.readFile('/system/connections/u%40openai.com.json'))
		)
		expect(onDisk.creds).toEqual({ sealed: JSON.stringify(c.creds) })
		expect(onDisk.id).toBe('u@openai.com')
		expect(onDisk.kind).toBe('chatgpt')

		expect(await store.get('u@openai.com')).toEqual(c)
	})
})
