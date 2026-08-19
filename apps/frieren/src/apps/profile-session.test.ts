import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const H = vi.hoisted(() => ({
	reset: vi.fn(),
	handshake: vi.fn(),
	reload: vi.fn(),
	deleteDatabase: vi.fn(),
	migrateIdb: vi.fn(async () => {}),
	// Which databases were opened, and how many sync loops were built and torn down.
	// One profile is one replica, whoever asks for it and however often.
	opened: vi.fn(),
	synced: vi.fn(),
	destroyed: vi.fn()
}))

vi.mock('@justfiles/core', () => ({
	createFsClient: () => ({ reset: { $post: H.reset }, index: { $get: H.handshake } })
}))

// A store per database name, and a real one: the module under test announces a mount
// and builds a volume over what this hands back, so a hand-rolled stub would only test
// the stub. `memStore` is the same seam `idbStore` implements.
vi.mock('@justfiles/fs/idb', async () => {
	const { memStore } = await import('@justfiles/fs/mem')
	const stores = new Map<string, ReturnType<typeof memStore>>()
	return {
		idbStore: (name: string) => {
			H.opened(name)
			const held = stores.get(name) ?? memStore()
			stores.set(name, held)
			return held
		},
		// The cross-tab wake is a latency optimization over polling `since`, and
		// nothing here measures latency.
		sharedStore: (store: unknown) => store,
		persistStorage: async () => true
	}
})

// The one pass from the old model has its own tests (`migrate.idb.test.ts`); here it
// is the boot step that must not run twice, which the registry marker read inside
// `adoptOnce` is what settles — so that half is the REAL one.
vi.mock('@justfiles/fs/migrate.idb', async (original) => ({
	...(await original<typeof import('@justfiles/fs/migrate.idb')>()),
	migrateIdb: H.migrateIdb
}))
vi.mock('@justfiles/fs/http', () => ({ httpStore: () => ({}) }))

vi.mock('@justfiles/fs/synced', async (original) => ({
	...(await original<Record<string, unknown>>()),
	synced: async () => {
		H.synced()
		return {
			readFile: async () => new Uint8Array(),
			flush: async () => {},
			pause: () => {},
			resume: () => {},
			destroy: H.destroyed,
			status: () => 'synced',
			onStatusChange: () => () => {},
			takeTheirs: async () => {},
			takeMine: async () => {},
			generation: () => 1
		}
	}
}))

type StoredProfile = {
	id: string
	remoteUserId?: string
	lastOpenedAt: number
	adopted?: true
	pendingFactoryReset?: { operationId: string; fromGeneration: number }
}

const REGISTRY_KEY = 'frieren-profiles'

function stubBrowser(registry: StoredProfile[] = []) {
	const data = new Map([[REGISTRY_KEY, JSON.stringify(registry)]])
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => data.set(key, value),
		removeItem: (key: string) => data.delete(key)
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
	// `subtle` is kept: a mount row's id is a hash of its position, so announcing one
	// is the first thing every profile does.
	vi.stubGlobal('crypto', { randomUUID: () => 'account-profile', subtle: globalThis.crypto.subtle })
	vi.stubGlobal('indexedDB', {
		deleteDatabase: H.deleteDatabase.mockImplementation(() => {
			const request: { onsuccess?: () => void } = {}
			void Promise.resolve().then(() => request.onsuccess?.())
			return request
		})
	})
	vi.stubGlobal('location', { reload: H.reload })
	return data
}

async function loadFs(registry?: StoredProfile[]) {
	vi.resetModules()
	const data = stubBrowser(registry)
	const fs = await import('../fs')
	return { data, fs }
}

const handshakeIs = (generation: number, lineageId?: string) =>
	H.handshake.mockResolvedValue({
		ok: true,
		status: 200,
		json: async () => ({ generation, lineageId })
	})

describe('profile session switching', () => {
	beforeEach(() => {
		H.reset.mockReset()
		H.handshake.mockReset()
		H.reload.mockReset()
		H.deleteDatabase.mockReset()
		H.migrateIdb.mockReset()
		H.opened.mockReset()
		H.synced.mockReset()
		H.destroyed.mockReset()
		handshakeIs(1)
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

	test('holds the current account profile until auth starts sync', async () => {
		const { fs } = await loadFs([
			{ id: 'account-profile', remoteUserId: 'user-1', lastOpenedAt: 2 },
			{ id: 'local', lastOpenedAt: 1 }
		])

		await expect(fs.openBootProfile()).resolves.toBeNull()
		expect(fs.activeProfileId()).toBe('account-profile')
	})

	test('boot opens local when the signed-out profile is current', async () => {
		const { fs } = await loadFs([
			{ id: 'account-profile', remoteUserId: 'user-1', lastOpenedAt: 1 },
			{ id: 'local', lastOpenedAt: 2 }
		])

		await fs.openProfile()

		expect(fs.activeProfileId()).toBe('local')
	})

	test('returns the current local profile before auth resolves', async () => {
		const { fs } = await loadFs([{ id: 'local', lastOpenedAt: 1 }])

		await expect(fs.openBootProfile()).resolves.toBe('local')
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

	test('the one pass runs once per profile, and the registry is what says so', async () => {
		const { data, fs } = await loadFs([{ id: 'local', lastOpenedAt: 1 }])

		await fs.openProfile()
		expect(H.migrateIdb).toHaveBeenCalledTimes(1)
		expect(JSON.parse(data.get(REGISTRY_KEY) ?? '[]')[0].adopted).toBe(true)

		// A second open of the same profile must not copy the old tree again: rule 3
		// only makes an IDENTICAL row a no-op, so a re-run over a live volume would
		// put stale rows back over what the user has written since.
		await fs.releaseFsVolume({ flush: false })
		await fs.openProfile()
		expect(H.migrateIdb).toHaveBeenCalledTimes(1)
	})

	test('two boots in one tick stand up one replica, not two', async () => {
		const { fs } = await loadFs([{ id: 'local', lastOpenedAt: 1 }])

		// React invokes a mount effect twice, so both calls are in flight before either
		// has an active profile to report. Two replicas of one database is two store
		// connections and two cross-tab channels, and only the last is ever closed.
		const [one, two] = await Promise.all([fs.openProfile(), fs.openProfile()])

		expect(one).toBe(two)
		expect(H.opened.mock.calls.map(([name]) => name)).toEqual([
			'frieren-store-local',
			'frieren-store-local-private'
		])
	})

	test('two attaches in one tick leave one sync loop running', async () => {
		const { fs } = await loadFs([{ id: 'local', lastOpenedAt: 1 }])
		await fs.openProfile()

		await Promise.all([
			fs.attachRemoteUser('user-1', async () => 'token'),
			fs.attachRemoteUser('user-1', async () => 'token')
		])

		// One loop, built once. A second one over the same store pushes the same rows at
		// the same time — and a `destroy` cannot take back the cycle the first already
		// has in flight, so "tear the old one down" is not an answer either.
		expect(H.synced).toHaveBeenCalledTimes(1)
		expect(H.destroyed).not.toHaveBeenCalled()
	})

	test('a released profile syncs again when it is attached again', async () => {
		const { fs } = await loadFs([{ id: 'local', lastOpenedAt: 1 }])
		await fs.openProfile()
		await fs.attachRemoteUser('user-1', async () => 'token')

		// Sign-out stops the loop; signing back in has to start one, or the account
		// looks synced on a replica that never talks to the server again.
		await fs.switchToLocalProfile()
		await fs.attachRemoteUser('user-1', async () => 'token')

		expect(H.synced).toHaveBeenCalledTimes(2)
	})

	test('factory reset reuses an operation after ambiguous confirmation failure', async () => {
		H.reset
			.mockResolvedValueOnce({ ok: false, status: 503 })
			.mockResolvedValueOnce({ ok: true, status: 200 })
		handshakeIs(4, 'vol-A')
		const { data, fs } = await loadFs([
			{ id: 'account-profile', remoteUserId: 'user-1', lastOpenedAt: 2 }
		])
		await fs.openProfile()

		await expect(fs.factoryReset(async () => 'token')).rejects.toThrow('factory reset failed: 503')
		const firstRequest = H.reset.mock.calls[0]?.[0]
		// The epoch is READ from the server, not remembered: `generation()` only ever
		// reports what a `reset()` returned, which is nothing on a replica that never
		// ran "take mine".
		expect(firstRequest.json).toMatchObject({ fromGeneration: 4, lineageId: 'vol-A' })
		expect(JSON.parse(data.get(REGISTRY_KEY) ?? '[]')[0].pendingFactoryReset).toEqual({
			operationId: firstRequest.json.operationId,
			fromGeneration: firstRequest.json.fromGeneration
		})

		await fs.factoryReset(async () => 'token')

		expect(H.reset.mock.calls[1]?.[0]).toEqual(firstRequest)
		expect(JSON.parse(data.get(REGISTRY_KEY) ?? '[]')[0].pendingFactoryReset).toBeUndefined()
		// Both stores this profile holds, and the old model's database the pass copied
		// out of: a reset that left any of the three would come back on the next boot.
		expect(H.deleteDatabase).toHaveBeenCalledWith('frieren-store-account-profile')
		expect(H.deleteDatabase).toHaveBeenCalledWith('frieren-store-account-profile-private')
		expect(H.deleteDatabase).toHaveBeenCalledWith('frieren-fs-profile-account-profile')
		expect(H.reload).toHaveBeenCalledOnce()
	})
})
