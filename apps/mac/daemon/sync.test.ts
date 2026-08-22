import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Kernel } from '@justfiles/app/runtime'
import { volume } from '@justfiles/fs'
import { authority } from '@justfiles/fs/authority'
import { memStore } from '@justfiles/fs/mem'
import { versions } from '@justfiles/fs/synced'
import { afterEach, expect, test } from 'vitest'
import { storeApi } from '../../../packages/core/src/store.api'
import { createNativeStorage, type NativeStorage, OwnerChangedError } from './fs'
import { runtimeRefresh } from './refresh'

const enc = new TextEncoder()
const dec = new TextDecoder()
const roots: string[] = []
const open: NativeStorage[] = []

afterEach(async () => {
	for (const storage of open.splice(0)) await storage.close()
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
	delete process.env.KODAMA_STORE_ORIGIN
})

async function temp(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'kodama-sync-'))
	roots.push(root)
	return root
}

function backend() {
	const store = authority(memStore())
	const fs = volume(store, { mintVersion: versions('backend') })
	const app = storeApi(store)
	let online = true
	const requests: { url: string; authorization: string | null }[] = []
	return {
		fs,
		requests,
		setOnline(value: boolean) {
			online = value
		},
		fetch: async (url: string, init?: RequestInit) => {
			requests.push({
				url,
				authorization: new Headers(init?.headers).get('authorization')
			})
			if (!online) throw new Error('offline')
			const request = new URL(url)
			return app.request(`${request.pathname.slice('/store'.length)}${request.search}`, init)
		}
	}
}

async function storage(
	supportDir: string,
	hub: ReturnType<typeof backend>,
	ownerId = 'user-a',
	getToken: () => Promise<string | null> = async () => 'token-a'
): Promise<NativeStorage> {
	const value = await createNativeStorage({
		supportDir,
		ownerId,
		getToken,
		origin: 'http://hub.test',
		fetch: hub.fetch,
		interval: 60_000
	})
	open.push(value)
	return value
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> {
	const end = Date.now() + timeoutMs
	while (!(await check())) {
		if (Date.now() >= end) throw new Error('timed out waiting for sync')
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
}

test('syncs both ways, uploads Finder edits, and keeps private data local', async () => {
	const support = await temp()
	const hub = backend()
	await hub.fs.writeFile('/from-backend.txt', enc.encode('remote'))
	const local = await storage(support, hub)

	expect(await local.flush()).toBe(true)
	expect(dec.decode(await local.volume.readFile('/from-backend.txt'))).toBe('remote')
	expect(await readFile(join(support, 'volume-v2', 'main', 'from-backend.txt'), 'utf8')).toBe(
		'remote'
	)

	await writeFile(join(support, 'volume-v2', 'main', 'finder.txt'), 'finder')
	await waitFor(async () => await hub.fs.exists('/finder.txt'))
	expect(dec.decode(await hub.fs.readFile('/finder.txt'))).toBe('finder')

	await hub.fs.writeFile('/from-backend.txt', enc.encode('changed'))
	expect(await local.flush()).toBe(true)
	expect(dec.decode(await local.volume.readFile('/from-backend.txt'))).toBe('changed')
	expect(await readFile(join(support, 'volume-v2', 'main', 'from-backend.txt'), 'utf8')).toBe(
		'changed'
	)

	await local.volume.writeFile('/private/secret.txt', enc.encode('local'))
	expect(await local.flush()).toBe(true)
	expect(await hub.fs.exists('/private')).toBe(false)
	expect(await hub.fs.exists('/secret.txt')).toBe(false)
}, 15_000)

test('keeps cursors and uses a fresh token for every request', async () => {
	const support = await temp()
	const hub = backend()
	let token = 'token-a'
	const getToken = async () => token
	let first = await storage(support, hub, 'user-a', getToken)

	await first.volume.writeFile('/local.txt', enc.encode('kept'))
	await first.flush()
	await first.close()
	open.splice(open.indexOf(first), 1)

	const state = JSON.parse(
		await readFile(join(support, 'volume-v2', 'sync.json'), 'utf8')
	) as Record<string, unknown>
	expect(state).toMatchObject({ ownerId: 'user-a', discard: false })
	expect(typeof state.replica).toBe('string')
	expect(typeof state.pull).toBe('string')
	expect(typeof state.push).toBe('string')
	await expect(access(join(support, 'volume-v2', 'sync.json.tmp'))).rejects.toThrow()

	token = 'token-b'
	await hub.fs.writeFile('/after-restart.txt', enc.encode('next'))
	first = await storage(support, hub, 'user-a', getToken)
	expect(await first.flush()).toBe(true)
	expect(dec.decode(await first.volume.readFile('/local.txt'))).toBe('kept')
	expect(dec.decode(await first.volume.readFile('/after-restart.txt'))).toBe('next')
	expect(hub.requests.some((request) => request.authorization === 'Bearer token-a')).toBe(true)
	expect(hub.requests.some((request) => request.authorization === 'Bearer token-b')).toBe(true)
})

test('uploads offline work after the backend returns', async () => {
	const support = await temp()
	const hub = backend()
	const local = await storage(support, hub)
	await local.flush()

	hub.setOnline(false)
	await local.volume.writeFile('/offline.txt', enc.encode('saved here'))
	expect(await local.flush(2_000)).toBe(false)
	expect(dec.decode(await local.volume.readFile('/offline.txt'))).toBe('saved here')

	hub.setOnline(true)
	expect(await local.flush()).toBe(true)
	expect(dec.decode(await hub.fs.readFile('/offline.txt'))).toBe('saved here')
}, 15_000)

test('reports the first successful remote cycle without blocking local work', async () => {
	const support = await temp()
	const hub = backend()
	hub.setOnline(false)
	const local = await storage(support, hub)
	let ready: boolean | undefined
	void local.firstSync.then((value) => {
		ready = value
	})

	await local.volume.writeFile('/offline.txt', enc.encode('local'))
	expect(dec.decode(await local.volume.readFile('/offline.txt'))).toBe('local')
	await new Promise((resolve) => setTimeout(resolve, 100))
	expect(ready).toBeUndefined()

	hub.setOnline(true)
	expect(await local.flush()).toBe(true)
	expect(await local.firstSync).toBe(true)
}, 15_000)

test('wipes the old owner before a new owner can connect', async () => {
	const support = await temp()
	const firstHub = backend()
	const first = await storage(support, firstHub)
	await first.volume.writeFile('/old-owner.txt', enc.encode('private to a'))
	await first.flush()
	await first.close()
	open.splice(open.indexOf(first), 1)
	const before = firstHub.requests.length

	await expect(
		createNativeStorage({
			supportDir: support,
			ownerId: 'user-b',
			getToken: async () => 'token-b',
			origin: 'http://hub.test',
			fetch: firstHub.fetch
		})
	).rejects.toBeInstanceOf(OwnerChangedError)
	expect(firstHub.requests).toHaveLength(before)
	await expect(access(join(support, 'volume-v2'))).rejects.toThrow()

	const secondHub = backend()
	const second = await storage(support, secondHub, 'user-b', async () => 'token-b')
	await second.flush()
	expect(await second.volume.exists('/old-owner.txt')).toBe(false)
	expect(await secondHub.fs.exists('/old-owner.txt')).toBe(false)
})

test('keeps the saved owner when identity is unresolved offline', async () => {
	const support = await temp()
	const hub = backend()
	let local = await storage(support, hub)
	await local.volume.writeFile('/offline-boot.txt', enc.encode('keep'))
	await local.close()
	open.splice(open.indexOf(local), 1)

	local = await createNativeStorage({
		supportDir: support,
		getToken: async () => null,
		origin: 'http://hub.test',
		fetch: hub.fetch,
		interval: 60_000
	})
	open.push(local)
	expect(local.ownerId).toBe('user-a')
	expect(dec.decode(await local.volume.readFile('/offline-boot.txt'))).toBe('keep')
})

test('keeps the saved owner while signed out and resumes for the same owner', async () => {
	const support = await temp()
	const hub = backend()
	let local = await storage(support, hub)
	await local.volume.writeFile('/local.txt', enc.encode('keep'))
	await local.flush()
	await local.close()
	open.splice(open.indexOf(local), 1)
	await hub.fs.writeFile('/while-signed-out.txt', enc.encode('remote'))

	let token: string | null = null
	local = await createNativeStorage({
		supportDir: support,
		ownerId: null,
		getToken: async () => token,
		origin: 'http://hub.test',
		fetch: (url, init) =>
			new Headers(init?.headers).get('authorization') === 'Bearer token-a'
				? hub.fetch(url, init)
				: Promise.resolve(new Response('Unauthorized', { status: 401 })),
		interval: 60_000
	})
	open.push(local)

	expect(local.ownerId).toBe('user-a')
	expect(dec.decode(await local.volume.readFile('/local.txt'))).toBe('keep')
	expect(await local.flush(500)).toBe(false)
	token = 'token-a'
	expect(await local.flush()).toBe(true)
	expect(dec.decode(await local.volume.readFile('/while-signed-out.txt'))).toBe('remote')
}, 15_000)

test('uses the Mac origin override', async () => {
	const support = await temp()
	const hub = backend()
	process.env.KODAMA_STORE_ORIGIN = 'http://override.test/base'
	const local = await createNativeStorage({
		supportDir: support,
		ownerId: 'user-a',
		getToken: async () => 'token-a',
		fetch: hub.fetch,
		interval: 60_000
	})
	open.push(local)
	await local.flush()
	expect(
		hub.requests.every((request) => request.url.startsWith('http://override.test/store'))
	).toBe(true)
})

test('refreshes a running app after an HTTP pull', async () => {
	const support = await temp()
	const hub = backend()
	await hub.fs.mkdir('/state', { recursive: true })
	await hub.fs.mkdir('/applications/app.one', { recursive: true })
	await hub.fs.writeFile('/state/app.one.json', enc.encode('{"count":1}'))
	await hub.fs.writeFile(
		'/applications/app.one/manifest.json',
		enc.encode('{"id":"app.one","version":"1"}')
	)
	const local = await storage(support, hub)
	await local.flush()

	const kernel = {
		async reloadBundle() {},
		async list() {
			return [{ id: 'app.one', name: 'One', app: 'app.js' }]
		},
		async state(appId: string) {
			return JSON.parse(dec.decode(await local.volume.readFile(`/state/${appId}.json`)))
		},
		subscribe: () => () => {}
	} as unknown as Kernel
	const states: unknown[] = []
	const reloads: string[] = []
	let applications = 0
	const refresh = runtimeRefresh({
		volume: Promise.resolve(local.volume),
		kernel: Promise.resolve(kernel),
		publishState: (_appId, next) => states.push(next),
		reloadApp: (appId) => reloads.push(appId),
		refreshApplications: async () => void applications++
	})
	await refresh.openApp('app.one')
	expect(states).toEqual([{ count: 1 }])

	await hub.fs.writeFile('/state/app.one.json', enc.encode('{"count":2}'))
	await local.flush()
	await waitFor(async () => states.length === 2)
	expect(states).toEqual([{ count: 1 }, { count: 2 }])

	await hub.fs.writeFile(
		'/applications/app.one/manifest.json',
		enc.encode('{"id":"app.one","version":"2"}')
	)
	await local.flush()
	await waitFor(async () => reloads.length === 1)
	expect(reloads).toEqual(['app.one'])

	await hub.fs.mkdir('/applications/app.two', { recursive: true })
	await hub.fs.writeFile(
		'/applications/app.two/manifest.json',
		enc.encode('{"id":"app.two","version":"1"}')
	)
	await local.flush()
	await waitFor(async () => applications > 0)

	const stateCount = states.length
	refresh.closeApp('app.one')
	await refresh.close()
	await hub.fs.writeFile('/state/app.one.json', enc.encode('{"count":3}'))
	await local.flush()
	await new Promise((resolve) => setTimeout(resolve, 100))
	expect(states).toHaveLength(stateCount)
}, 15_000)
