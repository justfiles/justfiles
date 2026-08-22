import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Kernel } from '@justfiles/app/runtime'
import { REMOTE_SOURCE, type Volume, volume } from '@justfiles/fs'
import { fsStore } from '@justfiles/fs/fs'
import { versions } from '@justfiles/fs/synced'
import { afterEach, expect, test, vi } from 'vitest'
import { runtimeRefresh } from './refresh'

const enc = new TextEncoder()
const roots: string[] = []
const stores: ReturnType<typeof fsStore>[] = []

afterEach(async () => {
	vi.useRealTimers()
	for (const store of stores.splice(0)) await store.close?.()
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

test('retries a failed remote state read', async () => {
	vi.useFakeTimers()
	let onState: ((event: { source?: string }) => void) | undefined
	const fs = {
		readFile: async () => enc.encode('{}'),
		watch: async (path: string, listener: (event: { source?: string }) => void) => {
			if (path === '/state/app.one.json') onState = listener
			return () => {}
		}
	} as unknown as Volume
	let attempts = 0
	let failed!: () => void
	const first = new Promise<void>((resolve) => {
		failed = resolve
	})
	const kernel = {
		async reload() {
			attempts++
			if (attempts === 1) {
				failed()
				throw new Error('offline')
			}
		},
		async state() {
			return { count: 2 }
		},
		subscribe: () => () => {}
	} as unknown as Kernel
	let published!: () => void
	const pushed = new Promise<void>((resolve) => {
		published = resolve
	})
	const states: unknown[] = []
	const refresh = runtimeRefresh({
		volume: Promise.resolve(fs),
		kernel: Promise.resolve(kernel),
		publishState: (_appId, state) => {
			states.push(state)
			published()
		},
		reloadApp: () => {},
		refreshApplications: async () => {}
	})
	await refresh.openApp('app.one')

	onState?.({ source: REMOTE_SOURCE })
	await first
	expect(states).toEqual([])
	expect(attempts).toBe(1)

	await vi.advanceTimersByTimeAsync(5_000)
	await pushed
	expect(attempts).toBe(2)
	expect(states).toEqual([{ count: 2 }])
	await refresh.close()
})

test('retries a failed remote manifest read', async () => {
	vi.useFakeTimers()
	let onManifest: ((event: { source?: string }) => void) | undefined
	let manifest = '{"version":1}'
	let offline = false
	let failed!: () => void
	const first = new Promise<void>((resolve) => {
		failed = resolve
	})
	const fs = {
		async readFile() {
			if (offline) {
				offline = false
				failed()
				throw new Error('offline')
			}
			return enc.encode(manifest)
		},
		watch: async (path: string, listener: (event: { source?: string }) => void) => {
			if (path === '/applications/app.one/manifest.json') onManifest = listener
			return () => {}
		}
	} as unknown as Volume
	const reloads: string[] = []
	const kernel = {
		async reloadBundle() {
			reloads.push('kernel')
		},
		subscribe: () => () => {}
	} as unknown as Kernel
	let published!: () => void
	const pushed = new Promise<void>((resolve) => {
		published = resolve
	})
	const refresh = runtimeRefresh({
		volume: Promise.resolve(fs),
		kernel: Promise.resolve(kernel),
		publishState: () => {},
		reloadApp: () => {
			reloads.push('browser')
			published()
		},
		refreshApplications: async () => {}
	})
	await refresh.openApp('app.one')
	expect(reloads).toEqual(['kernel'])

	manifest = '{"version":2}'
	offline = true
	onManifest?.({ source: REMOTE_SOURCE })
	await first
	expect(reloads).toEqual(['kernel'])

	await vi.advanceTimersByTimeAsync(5_000)
	await pushed
	expect(reloads).toEqual(['kernel', 'kernel', 'browser'])
	await refresh.close()
})

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
	const end = Date.now() + timeoutMs
	while (!check()) {
		if (Date.now() >= end) throw new Error('timed out waiting for runtime refresh')
		await new Promise((resolve) => setTimeout(resolve, 20))
	}
}

test('invalidates a bundle without an app socket', async () => {
	let manifest = '{"id":"app.one","version":"1"}'
	let onManifest: ((event: { source?: string }) => void) | undefined
	let stopped = false
	const fs = {
		readFile: async () => enc.encode(manifest),
		watch: async (path: string, listener: (event: { source?: string }) => void) => {
			if (path !== '/applications/app.one/manifest.json') return () => {}
			onManifest = listener
			return () => {
				stopped = true
			}
		}
	} as unknown as Volume
	const reloads: string[] = []
	const browsers: string[] = []
	const kernel = {
		async list() {
			return [{ id: 'app.one', name: 'One', app: 'app.js' }]
		},
		async reloadBundle(appId: string) {
			reloads.push(appId)
		},
		subscribe: () => () => {}
	} as unknown as Kernel
	const refresh = runtimeRefresh({
		volume: Promise.resolve(fs),
		kernel: Promise.resolve(kernel),
		publishState: () => {},
		reloadApp: (appId) => browsers.push(appId),
		refreshApplications: async () => {}
	})

	await refresh.refreshApps()
	expect(reloads).toEqual(['app.one'])

	manifest = '{"id":"app.one","version":"2"}'
	onManifest?.({ source: REMOTE_SOURCE })
	await waitFor(() => reloads.length === 2)
	expect(browsers).toEqual([])

	await refresh.close()
	expect(stopped).toBe(true)
})

test('refreshes remote state and bundles, then stops each watch', async () => {
	const root = await mkdtemp(join(tmpdir(), 'kodama-refresh-'))
	roots.push(root)
	const store = fsStore(root, { mintVersion: versions('local') })
	stores.push(store)
	const local = volume(store, { mintVersion: versions('local') })
	const remote = volume(store, { mintVersion: versions('remote') })
	await local.mkdir('/state', { recursive: true })
	await local.mkdir('/applications/app.one', { recursive: true })
	await local.writeFile('/state/app.one.json', enc.encode('{"count":1}'))
	await local.writeFile(
		'/applications/app.one/manifest.json',
		enc.encode('{"id":"app.one","version":"1"}')
	)

	let state: unknown
	let handler: ((event: unknown) => void) | undefined
	let bundleGate: Promise<void> | undefined
	let subscribed = (): void => {}
	const subscription = new Promise<void>((resolve) => {
		subscribed = resolve
	})
	const kernel = {
		async reload(appId: string) {
			state = JSON.parse(new TextDecoder().decode(await local.readFile(`/state/${appId}.json`)))
		},
		async reloadBundle(appId: string) {
			reloads.push(`kernel:${appId}`)
			await bundleGate
		},
		async state() {
			return state
		},
		async list() {
			return [{ id: 'app.one', name: 'One', app: 'app.js' }]
		},
		subscribe(next: (event: unknown) => void) {
			handler = next
			subscribed()
			return () => {
				handler = undefined
			}
		}
	} as unknown as Kernel
	const states: unknown[] = []
	const reloads: string[] = []
	let applications = 0
	const refresh = runtimeRefresh({
		volume: Promise.resolve(local),
		kernel: Promise.resolve(kernel),
		publishState: (_appId, next) => states.push(next),
		reloadApp: (appId) => reloads.push(`browser:${appId}`),
		refreshApplications: async () => void applications++
	})
	await Promise.all([subscription, refresh.openApp('app.one')])
	expect(reloads).toEqual(['kernel:app.one'])

	await remote.writeFile('/state/app.one.json', enc.encode('{"count":2}'))
	await waitFor(() => states.length === 1)
	expect(states).toEqual([{ count: 2 }])

	await remote.writeFile(
		'/applications/app.one/manifest.json',
		enc.encode('{"id":"app.one","version":"2"}')
	)
	await waitFor(() => reloads.length === 3)
	expect(reloads).toEqual(['kernel:app.one', 'kernel:app.one', 'browser:app.one'])

	await remote.mkdir('/applications/app.two', { recursive: true })
	await remote.writeFile(
		'/applications/app.two/manifest.json',
		enc.encode('{"id":"app.two","version":"1"}')
	)
	await waitFor(() => applications > 0)

	const stateCount = states.length
	const reloadCount = reloads.length
	refresh.closeApp('app.one')
	let releaseBundle!: () => void
	bundleGate = new Promise((resolve) => {
		releaseBundle = resolve
	})
	await remote.writeFile('/state/app.one.json', enc.encode('{"count":3}'))
	await remote.writeFile(
		'/applications/app.one/manifest.json',
		enc.encode('{"id":"app.one","version":"3"}')
	)
	await waitFor(() => reloads.length === reloadCount + 1)
	expect(states).toHaveLength(stateCount)

	let opened = false
	const opening = refresh.openApp('app.one').then(() => {
		opened = true
	})
	await new Promise((resolve) => setTimeout(resolve, 50))
	expect(opened).toBe(false)
	expect(reloads).toHaveLength(reloadCount + 1)

	releaseBundle()
	await opening
	expect(opened).toBe(true)
	expect(reloads.slice(-2)).toEqual(['kernel:app.one', 'browser:app.one'])
	refresh.closeApp('app.one')

	const applicationCount = applications
	await refresh.close()
	await remote.mkdir('/applications/app.three', { recursive: true })
	await new Promise((resolve) => setTimeout(resolve, 100))
	expect(applications).toBe(applicationCount)
	expect(handler).toBeUndefined()
})

test('uses kernel events for local state and catalog changes', async () => {
	const root = await mkdtemp(join(tmpdir(), 'kodama-refresh-events-'))
	roots.push(root)
	const store = fsStore(root)
	stores.push(store)
	const fs = volume(store)
	let handler: ((event: unknown) => void) | undefined
	let subscribed = (): void => {}
	const subscription = new Promise<void>((resolve) => {
		subscribed = resolve
	})
	const kernel = {
		async list() {
			return []
		},
		subscribe(next: (event: unknown) => void) {
			handler = next
			subscribed()
			return () => {
				handler = undefined
			}
		}
	} as unknown as Kernel
	const states: unknown[] = []
	let applications = 0
	const refresh = runtimeRefresh({
		volume: Promise.resolve(fs),
		kernel: Promise.resolve(kernel),
		publishState: (_appId, state) => states.push(state),
		reloadApp: () => {},
		refreshApplications: async () => void applications++
	})
	await subscription

	handler?.({ type: 'app.update', appId: 'app.one', state: { count: 1 }, seq: 1 })
	handler?.({ type: 'app.installed', appId: 'app.one' })
	await waitFor(() => applications === 1)
	expect(states).toEqual([{ count: 1 }])

	await refresh.close()
})
