import { memStore } from '@justfiles/fs/mem'
import { receiver } from '@justfiles/fs/peer'
import { type Cursor, type Node, ROOT, type Store } from '@justfiles/fs/store'
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
	destroyed: vi.fn(),
	peer: {} as unknown,
	stores: new Map<string, unknown>()
}))

vi.mock('@justfiles/core', () => ({
	createFsClient: () => ({ reset: { $post: H.reset }, index: { $get: H.handshake } })
}))

// A store per database name, and a real one: the module under test announces a mount
// and builds a volume over what this hands back, so a hand-rolled stub would only test
// the stub. `memStore` is the same seam `idbStore` implements.
vi.mock('@justfiles/fs/idb', async () => {
	const { acquireStoreOwner } =
		await vi.importActual<typeof import('@justfiles/fs/idb')>('@justfiles/fs/idb')
	const { memStore } = await import('@justfiles/fs/mem')
	return {
		acquireStoreOwner,
		idbStore: (name: string) => {
			H.opened(name)
			const held = H.stores.get(name) ?? memStore()
			H.stores.set(name, held)
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
vi.mock('@justfiles/fs/http', () => ({ httpStore: () => H.peer }))

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
	storeDb?: string
	pendingBootstrap?: { freshDb: string }
	pendingFactoryReset?: { operationId: string; fromGeneration: number }
}

const REGISTRY_KEY = 'frieren-profiles-v2'

function stubBrowser(registry: StoredProfile[] = []) {
	const data = new Map([[REGISTRY_KEY, JSON.stringify(registry)]])
	const locks = new Map<string, Promise<unknown>>()
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => data.set(key, value),
		removeItem: (key: string) => data.delete(key)
	})
	vi.stubGlobal('window', {
		addEventListener: vi.fn(),
		removeEventListener: vi.fn()
	})
	vi.stubGlobal('navigator', {
		locks: {
			request: <T>(
				name: string,
				optionsOrBody: object | (() => Promise<T>),
				maybeBody?: () => Promise<T>
			): Promise<T> => {
				const body = (maybeBody ?? optionsOrBody) as () => Promise<T>
				const run = (locks.get(name) ?? Promise.resolve()).then(() => body())
				locks.set(
					name,
					run.catch(() => undefined)
				)
				return run
			}
		}
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
		H.peer = receiver(memStore())
		H.stores.clear()
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
			'frieren-store-v2-local',
			'frieren-store-v2-local-private'
		])
	})

	test('a second tab opens no store until the browser owner closes', async () => {
		const { data, fs } = await loadFs([{ id: 'local', lastOpenedAt: 1 }])
		const before = data.get(REGISTRY_KEY)
		let close!: () => void
		let opened!: () => void
		const firstOwns = new Promise<void>((resolve) => {
			opened = resolve
		})
		const staysOpen = new Promise<void>((resolve) => {
			close = resolve
		})
		const firstTab = navigator.locks.request('frieren-fs-owner', async () => {
			opened()
			await staysOpen
		})
		await firstOwns

		const secondTab = fs.openProfile()
		await Promise.resolve()
		expect(data.get(REGISTRY_KEY)).toBe(before)
		expect(H.opened).not.toHaveBeenCalled()

		close()
		await firstTab
		await secondTab
		expect(H.opened).toHaveBeenCalledTimes(2)
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

	test('a volume its holder destroyed syncs again when it is attached again', async () => {
		const { fs } = await loadFs([{ id: 'local', lastOpenedAt: 1 }])
		await fs.openProfile()
		const volume = await fs.attachRemoteUser('user-1', async () => 'token')

		volume.destroy()
		await fs.attachRemoteUser('user-1', async () => 'token')

		// A destroyed loop is terminal, so holding a reference to one would leave the
		// profile reading as synced on a replica nothing syncs — the attach that follows
		// leaves a loop that is already there alone.
		expect(H.destroyed).toHaveBeenCalledTimes(1)
		expect(H.synced).toHaveBeenCalledTimes(2)
	})

	test('an expired cursor switches stores without accepting late writes on the old one', async () => {
		const { data, fs } = await loadFs([
			{
				id: 'account-profile',
				remoteUserId: 'user-1',
				lastOpenedAt: 1,
				adopted: true
			}
		])
		const { memStore } = await import('@justfiles/fs/mem')
		const { receiver } = await import('@justfiles/fs/peer')
		let now = 0
		const remote = memStore()
		const remoteRow: Node = {
			id: 'remote',
			parent: ROOT,
			name: 'remote.txt',
			type: 'file',
			mode: 0o100644,
			mtimeNs: 0n,
			size: 0n,
			version: 'remote:1'
		}
		await remote.commit([remoteRow])
		const peer = receiver(remote, { clock: () => now })
		const expired = (await peer.since()).next
		now = 30 * 24 * 60 * 60 * 1_000
		let continueBootstrap!: () => void
		let bootstrapStarted!: () => void
		const bootstrap = new Promise<void>((resolve) => {
			bootstrapStarted = resolve
		})
		const blocked = new Promise<void>((resolve) => {
			continueBootstrap = resolve
		})
		H.peer = {
			...peer,
			since: async (cursor?: Cursor) => {
				if (cursor === undefined) {
					bootstrapStarted()
					await blocked
				}
				return peer.since(cursor)
			}
		}
		data.set('frieren-fs-account-profile-pull', expired as string)
		const volume = await fs.openProfile()
		const old = H.stores.get('frieren-store-v2-account-profile') as Store
		const staleRow: Node = {
			...remoteRow,
			id: 'offline',
			name: 'offline.txt',
			version: 'account-profile:offline'
		}
		await old.commit([staleRow])

		const attaching = fs.attachRemoteUser('user-1', async () => 'token')
		await bootstrap
		const lateWrite = expect(
			volume.writeFile('/late.txt', new TextEncoder().encode('late'))
		).rejects.toMatchObject({
			name: 'BootstrapRequiredError',
			message: 'bootstrap required'
		})
		continueBootstrap()
		const replacement = await attaching
		await lateWrite

		const profile = JSON.parse(data.get(REGISTRY_KEY) ?? '[]')[0] as StoredProfile & {
			storeDb?: string
			pendingBootstrap?: unknown
			retiredStoreDbs?: string[]
		}
		const fresh = H.stores.get(profile.storeDb as string) as Store
		const recovery = H.stores.get('frieren-recovery-v2-account-profile') as Store
		expect(await fresh.get('remote')).toEqual(remoteRow)
		expect(await fresh.get('offline')).toBeNull()
		expect(await replacement.exists('/late.txt')).toBe(false)
		expect(await recovery.get('offline')).toEqual(staleRow)
		expect(profile.pendingBootstrap).toBeUndefined()
		expect(profile.retiredStoreDbs).toBeUndefined()
	})

	test('another tab waits for the tab that owns a pending bootstrap', async () => {
		const freshDb = 'frieren-store-v2-account-profile-bootstrap-other-tab'
		const { fs } = await loadFs([
			{
				id: 'account-profile',
				remoteUserId: 'user-1',
				lastOpenedAt: 1,
				adopted: true,
				pendingBootstrap: { freshDb }
			}
		])
		let resume!: () => void
		let locked!: () => void
		const acquired = new Promise<void>((resolve) => {
			locked = resolve
		})
		const held = new Promise<void>((resolve) => {
			resume = resolve
		})
		const owner = navigator.locks.request('frieren-sync-state-account-profile', async () => {
			locked()
			await held
		})
		await acquired

		const opening = fs.openProfile()
		await Promise.resolve()
		expect(H.deleteDatabase).not.toHaveBeenCalled()

		resume()
		await owner
		await opening
		expect(H.deleteDatabase).toHaveBeenCalledWith(freshDb)
	})

	test('an old tab does not start sync after another tab switches stores', async () => {
		const { data, fs } = await loadFs([
			{
				id: 'account-profile',
				remoteUserId: 'user-1',
				lastOpenedAt: 1,
				adopted: true
			}
		])
		await fs.openProfile()
		const profiles = JSON.parse(data.get(REGISTRY_KEY) ?? '[]') as StoredProfile[]
		profiles[0]!.storeDb = 'frieren-store-v2-account-profile-new'
		data.set(REGISTRY_KEY, JSON.stringify(profiles))

		await fs.attachRemoteUser('user-1', async () => 'token')

		expect(H.synced).not.toHaveBeenCalled()
		expect(H.reload).toHaveBeenCalledOnce()
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
		expect(H.deleteDatabase).toHaveBeenCalledWith('frieren-store-v2-account-profile')
		expect(H.deleteDatabase).toHaveBeenCalledWith('frieren-store-v2-account-profile-private')
		expect(H.deleteDatabase).toHaveBeenCalledWith('frieren-fs-profile-account-profile')
		expect(H.reload).toHaveBeenCalledOnce()
	})
})
