import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModels, type OAuthCredential, type Provider } from '@earendil-works/pi-ai'
import { volume } from '@justfiles/fs'
import { fsStore } from '@justfiles/fs/fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { volumeCredentials } from './credentials.ts'

const PATH = '/ghost/credentials.json'

describe('volumeCredentials', () => {
	let root: string
	// A fresh store over the same directory each time: what a restarted daemon sees.
	const open = () => volumeCredentials(volume(fsStore(root)), PATH)

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'credentials-'))
	})

	afterEach(async () => {
		await rm(root, { recursive: true, force: true })
	})

	it('keeps one credential per provider across a restart, readable only by the owner', async () => {
		const store = open()
		expect(await store.read('openai')).toBeUndefined()
		await store.modify('openai', async () => oauth('a', Date.now() + 3_600_000))
		await store.modify('anthropic', async () => ({ type: 'api_key', key: 'k' }))
		expect(await store.modify('openai', async () => undefined)).toMatchObject({ access: 'a' })

		const reopened = open()
		expect(await reopened.read('openai')).toMatchObject({ type: 'oauth', access: 'a' })
		expect(await reopened.list()).toEqual([
			{ providerId: 'openai', type: 'oauth' },
			{ providerId: 'anthropic', type: 'api_key' }
		])
		expect((await stat(join(root, 'ghost', 'credentials.json'))).mode & 0o777).toBe(0o600)

		await reopened.delete('openai')
		expect(await open().list()).toEqual([{ providerId: 'anthropic', type: 'api_key' }])
	})

	it('runs one modify at a time, each seeing the one before', async () => {
		const store = open()
		const seen: (string | undefined)[] = []
		await Promise.all(
			['1', '2', '3'].map((access) =>
				store.modify('openai', async (current) => {
					seen.push(current?.type === 'oauth' ? current.access : undefined)
					await new Promise((resolve) => setTimeout(resolve, 5))
					return oauth(access, 0)
				})
			)
		)
		expect(seen).toEqual([undefined, '1', '2'])
	})

	it('refreshes an expired sign-in once for concurrent requests and keeps the new one', async () => {
		let refreshes = 0
		const models = createModels({ credentials: open() })
		models.setProvider(provider(async () => oauth(`fresh-${++refreshes}`, Date.now() + 3_600_000)))
		await open().modify('chat', async () => oauth('stale', Date.now() - 1))

		const auths = await Promise.all([models.getAuth('chat'), models.getAuth('chat')])

		expect(auths.map((auth) => auth?.auth.apiKey)).toEqual(['fresh-1', 'fresh-1'])
		expect(refreshes).toBe(1)
		expect(await open().read('chat')).toMatchObject({ access: 'fresh-1' })
	})
})

function oauth(access: string, expires: number): OAuthCredential {
	return { type: 'oauth', access, refresh: `refresh-${access}`, expires }
}

/** A provider with nothing but OAuth, refreshing with `refresh`. */
function provider(refresh: () => Promise<OAuthCredential>): Provider {
	const unused = () => {
		throw new Error('not used')
	}
	return {
		id: 'chat',
		name: 'Chat',
		auth: {
			oauth: {
				name: 'Chat',
				login: unused,
				refresh: async () => {
					// Slow enough that the second request waits on the lock, not on a stale read.
					await new Promise((resolve) => setTimeout(resolve, 20))
					return refresh()
				},
				toAuth: async (credential) => ({ apiKey: credential.access })
			}
		},
		getModels: () => [],
		stream: unused,
		streamSimple: unused
	}
}
