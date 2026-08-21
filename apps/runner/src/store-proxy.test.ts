import type { CapabilityCall } from '@justfiles/app/capabilities'
import { volume } from '@justfiles/fs'
import { authority } from '@justfiles/fs/authority'
import { httpStore } from '@justfiles/fs/http'
import { memStore } from '@justfiles/fs/mem'
import { Hono } from 'hono'
import { afterEach, expect, test, vi } from 'vitest'
import { storeApi } from '../../../packages/core/src/store.api'
import { putAccount } from './auth/account'
import { appAccess } from './auth/capability'
import { putGrant } from './auth/grant'
import { toBase64Url } from './auth/secret'
import { createSession } from './auth/session'
import { testDatabase } from './auth/test-db'
import { tokenCodec } from './auth/token'
import { onlineVolumeCapability } from './client/online-volume'
import worker from './index'
import type { ReleaseManifest } from './protocol'

afterEach(() => vi.unstubAllGlobals())

test('the Store proxy checks the app grant and strips Runner credentials upstream', async () => {
	const setup = await ready()
	let upstream: Request | undefined
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			upstream = nodeRequest(input, init)
			return Response.json({ row: 'from Frieren' })
		})
	)

	const response = await setup.request('/_runner/store/node/root')

	expect(response.status).toBe(200)
	expect(response.headers.get('cache-control')).toBe('no-store')
	expect(await response.json()).toEqual({ row: 'from Frieren' })
	expect(upstream?.url).toBe('https://mykodama.app/store/node/root')
	expect(upstream?.headers.get('authorization')).toBe('Bearer access-token')
	expect(upstream?.headers.get('cookie')).toBeNull()
	expect(upstream?.headers.get('origin')).toBeNull()
	expect(upstream?.headers.get('x-runner-request')).toBeNull()
})

test('the Store proxy streams writes with the protocol content type', async () => {
	const setup = await ready()
	let upstream: Request | undefined
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			upstream = nodeRequest(input, init)
			return new Response(null, { status: 204 })
		})
	)
	const body = JSON.stringify({ writes: [], guards: [] })

	const response = await setup.request('/_runner/store/commit', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body
	})

	expect(response.status).toBe(204)
	expect(upstream?.method).toBe('POST')
	expect(upstream?.headers.get('content-type')).toBe('application/json')
	expect(await upstream?.text()).toBe(body)
})

test('the Store proxy rejects requests outside the exact session and wire', async () => {
	const setup = await ready()
	const fetcher = vi.fn(async () => new Response(null, { status: 204 }))
	vi.stubGlobal('fetch', fetcher)

	expect(
		(await setup.request('/_runner/store/node/root', {}, { origin: null, browserGet: true })).status
	).toBe(204)
	fetcher.mockClear()
	expect((await setup.request('/_runner/store/node/root', {}, { nonce: '' })).status).toBe(403)
	expect(
		(await setup.request('/_runner/store/node/root', {}, { origin: null, browserGet: false }))
			.status
	).toBe(403)
	expect(
		(await setup.request('/_runner/store/node/root', {}, { origin: 'https://attacker.example' }))
			.status
	).toBe(403)
	expect(
		(await setup.request('/_runner/store/node/root', {}, { host: 'bob-tasks.example.com' })).status
	).toBe(403)
	expect((await setup.request('/_runner/store/file/root')).status).toBe(405)
	expect(
		(
			await setup.request('/_runner/store/commit', {
				method: 'POST',
				headers: { 'content-type': 'text/plain' },
				body: '{}'
			})
		).status
	).toBe(415)
	expect(fetcher).not.toHaveBeenCalled()
})

test('a capability change stops the Store proxy until the user approves it', async () => {
	const setup = await ready()
	setup.manifest.capabilities = {
		...setup.manifest.capabilities,
		notify: { id: 'notify', scopes: [] }
	}
	const fetcher = vi.fn(async () => new Response(null, { status: 204 }))
	vi.stubGlobal('fetch', fetcher)

	expect((await setup.request('/_runner/store/node/root')).status).toBe(403)
	expect(fetcher).not.toHaveBeenCalled()
})

test('online app changes are visible in Frieren without a sync pass', async () => {
	const setup = await ready()
	const frierenStore = authority(memStore())
	const frierenVolume = volume(frierenStore)
	const frieren = new Hono().route('/store', storeApi(frierenStore))
	vi.stubGlobal(
		'fetch',
		vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
			frieren.request(nodeRequest(input, init))
		)
	)
	const remote = volume(
		httpStore('https://alice-notes.example.com/_runner/store', {
			fetch: (url, init) => {
				const target = new URL(url)
				return setup.request(`${target.pathname}${target.search}`, init)
			}
		})
	)
	const cap = onlineVolumeCapability(remote, 'alice.notes', [['app']])
	const call = (method: string, args: unknown[]): CapabilityCall => ({
		appId: 'alice.notes',
		capability: 'volume',
		method,
		args,
		scopes: ['app']
	})
	const data = new TextEncoder().encode('one')

	await cap.invoke(call('writeFile', ['/notes/one.txt', data]))
	expect(
		new TextDecoder().decode(await frierenVolume.readFile('/data/alice.notes/notes/one.txt'))
	).toBe('one')
	expect(
		new TextDecoder().decode((await cap.invoke(call('readFile', ['/notes/one.txt']))) as Uint8Array)
	).toBe('one')
	await cap.invoke(call('writeFile', ['/notes/one.txt', new TextEncoder().encode('two')]))
	await cap.invoke(call('rename', ['/notes/one.txt', '/notes/two.txt']))
	expect(await frierenVolume.exists('/data/alice.notes/notes/one.txt')).toBe(false)
	expect(await frierenVolume.exists('/data/alice.notes/notes/two.txt')).toBe(true)
	await cap.invoke(call('rm', ['/notes/two.txt']))
	expect(await frierenVolume.exists('/data/alice.notes/notes/two.txt')).toBe(false)
})

async function ready() {
	const { binding, database } = testDatabase()
	const manifest: ReleaseManifest = {
		schema: 'justapps/manifest/v1',
		id: 'alice.notes',
		name: 'Notes',
		version: '1.0.0',
		app: 'app.js',
		gui: 'gui.js',
		capabilities: { volume: { id: 'volume', scopes: ['app'] } },
		hash: 'release-hash',
		files: []
	}
	const key = toBase64Url(new Uint8Array(32).fill(7))
	const env = {
		ROOT_DOMAIN: 'example.com',
		FRIEREN_ORIGIN: 'https://mykodama.app',
		CLERK_ISSUER: 'https://clerk.example.com',
		CLERK_CLIENT_ID: 'client_1',
		CLERK_CLIENT_SECRET: 'secret_1',
		TOKEN_SEAL_KEY_V1: key,
		GITHUB_TOKEN: 'unused',
		AUTH_DB: binding,
		STORE: {
			get: async (objectKey: string) => {
				if (objectKey === 'apps/alice.notes/record.json')
					return {
						json: async () => ({ current: '1.0.0', releases: { '1.0.0': { state: 'ready' } } })
					}
				if (objectKey === 'apps/alice.notes/1.0.0/manifest.json')
					return { json: async () => manifest }
				return null
			}
		} as unknown as R2Bucket
	} as unknown as CloudflareBindings
	await putAccount(database, tokenCodec(key), {
		userId: 'user_1',
		accessToken: 'access-token',
		refreshToken: 'refresh-token',
		accessExpiresAt: Date.now() + 60 * 60 * 1_000,
		scopes: ['openid', 'offline_access']
	})
	const access = await appAccess(manifest.id, manifest.capabilities)
	await putGrant(database, {
		userId: 'user_1',
		appId: manifest.id,
		capabilityHash: access.hash,
		resources: access.resources
	})
	const session = await createSession(database, {
		kind: 'app',
		userId: 'user_1',
		appId: manifest.id
	})

	return {
		env,
		manifest,
		request: (
			path: string,
			init: RequestInit = {},
			overrides: {
				nonce?: string
				origin?: string | null
				host?: string
				browserGet?: boolean
			} = {}
		) => {
			const headers = new Headers(init.headers)
			headers.set('cookie', `__Host-runner-app=${session.id}`)
			if (overrides.origin !== null)
				headers.set('origin', overrides.origin ?? 'https://alice-notes.example.com')
			if (overrides.browserGet) {
				headers.set('sec-fetch-site', 'same-origin')
				headers.set('sec-fetch-mode', 'cors')
			}
			headers.set('x-runner-request', overrides.nonce ?? session.requestNonce ?? '')
			return worker.fetch(
				new Request(`https://${overrides.host ?? 'alice-notes.example.com'}${path}`, {
					...init,
					headers
				}),
				env,
				{} as ExecutionContext
			)
		}
	}
}

function nodeRequest(input: RequestInfo | URL, init?: RequestInit): Request {
	return new Request(input, {
		...init,
		duplex: init?.body ? 'half' : undefined
	} as RequestInit)
}
