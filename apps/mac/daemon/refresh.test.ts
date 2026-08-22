import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Kernel } from '@justfiles/app/runtime'
import { volume } from '@justfiles/fs'
import { fsStore } from '@justfiles/fs/fs'
import { versions } from '@justfiles/fs/synced'
import { afterEach, expect, test } from 'vitest'
import { runtimeRefresh } from './refresh'

const enc = new TextEncoder()
const roots: string[] = []
const stores: ReturnType<typeof fsStore>[] = []

afterEach(async () => {
	for (const store of stores.splice(0)) await store.close?.()
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
	const end = Date.now() + timeoutMs
	while (!check()) {
		if (Date.now() >= end) throw new Error('timed out waiting for runtime refresh')
		await new Promise((resolve) => setTimeout(resolve, 20))
	}
}

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
		},
		async state() {
			return state
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

	await remote.writeFile('/state/app.one.json', enc.encode('{"count":2}'))
	await waitFor(() => states.length === 1)
	expect(states).toEqual([{ count: 2 }])

	await remote.writeFile(
		'/applications/app.one/manifest.json',
		enc.encode('{"id":"app.one","version":"2"}')
	)
	await waitFor(() => reloads.length === 2)
	expect(reloads).toEqual(['kernel:app.one', 'browser:app.one'])

	await remote.mkdir('/applications/app.two', { recursive: true })
	await remote.writeFile(
		'/applications/app.two/manifest.json',
		enc.encode('{"id":"app.two","version":"1"}')
	)
	await waitFor(() => applications > 0)

	const stateCount = states.length
	const reloadCount = reloads.length
	refresh.closeApp('app.one')
	await remote.writeFile('/state/app.one.json', enc.encode('{"count":3}'))
	await remote.writeFile(
		'/applications/app.one/manifest.json',
		enc.encode('{"id":"app.one","version":"3"}')
	)
	await new Promise((resolve) => setTimeout(resolve, 100))
	expect(states).toHaveLength(stateCount)
	expect(reloads).toHaveLength(reloadCount)

	await refresh.openApp('app.one')
	await waitFor(() => reloads.length === reloadCount + 2)
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
