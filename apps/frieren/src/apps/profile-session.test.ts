import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('@justfiles/core', () => ({
	apiStorage: async () => ({}),
	createFsClient: () => ({})
}))

vi.mock('@justfiles/fs/storage/idb', () => ({
	idbStorage: (name: string) => ({
		name,
		rootIno: '1',
		destroy: () => {}
	})
}))

vi.mock('@justfiles/fs', () => ({
	volume: () => ({
		readFile: async () => new Uint8Array()
	}),
	synced: async () => ({
		readFile: async () => new Uint8Array(),
		flush: async () => {},
		pause: () => {},
		resume: () => {},
		destroy: () => {},
		status: () => 'synced',
		onStatusChange: () => () => {}
	})
}))

type StoredProfile = {
	id: string
	remoteUserId?: string
	lastOpenedAt: number
}

const REGISTRY_KEY = 'frieren-profiles'

function stubBrowser(registry: StoredProfile[] = []) {
	const data = new Map([[REGISTRY_KEY, JSON.stringify(registry)]])
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => data.set(key, value)
	})
	vi.stubGlobal('window', {
		addEventListener: vi.fn(),
		removeEventListener: vi.fn()
	})
	vi.stubGlobal('document', {
		visibilityState: 'visible',
		addEventListener: vi.fn(),
		removeEventListener: vi.fn()
	})
	vi.stubGlobal('crypto', { randomUUID: () => 'account-profile' })
	return data
}

async function loadFs(registry?: StoredProfile[]) {
	vi.resetModules()
	const data = stubBrowser(registry)
	const fs = await import('../fs')
	return { data, fs }
}

describe('profile session switching', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-05-31T00:00:00Z'))
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllGlobals()
	})

	test('boot opens the current account profile before auth sync', async () => {
		const { fs } = await loadFs([
			{ id: 'account-profile', remoteUserId: 'user-1', lastOpenedAt: 2 },
			{ id: 'local', lastOpenedAt: 1 }
		])

		await fs.openProfile()

		expect(fs.activeProfileId()).toBe('account-profile')
		expect(fs.activeRemoteUserId()).toBe('user-1')
	})

	test('boot opens local when the signed-out profile is current', async () => {
		const { fs } = await loadFs([
			{ id: 'account-profile', remoteUserId: 'user-1', lastOpenedAt: 1 },
			{ id: 'local', lastOpenedAt: 2 }
		])

		await fs.openProfile()

		expect(fs.activeProfileId()).toBe('local')
	})

	test('sign-out switches from an account profile back to local', async () => {
		const { data, fs } = await loadFs([{ id: 'local', lastOpenedAt: 1 }])

		await fs.openProfile()
		await fs.attachRemoteUser('user-1', async () => 'token')
		expect(fs.activeProfileId()).toBe('account-profile')

		await fs.switchToLocalProfile()

		expect(fs.activeProfileId()).toBe('local')
		expect(JSON.parse(data.get(REGISTRY_KEY) ?? '[]')).toContainEqual(
			expect.objectContaining({ id: 'account-profile', remoteUserId: 'user-1' })
		)
	})
})
