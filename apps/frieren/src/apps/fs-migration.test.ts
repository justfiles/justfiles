import { FileType } from '@justfiles/fs/types'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PRIVATE_MOUNT } from '../../shared/private'

// Real stores, one per database name — `memStore` is the same seam `idbStore`
// implements, so the module under test announces its mount and builds its volume over
// the genuine article. Only the two things a browser has and node does not are faked.
const H = vi.hoisted(() => ({ stores: new Map<string, unknown>() }))

vi.mock('@justfiles/fs/store.idb', async () => {
	const { memStore } = await import('@justfiles/fs/store.mem')
	return {
		idbStore: (name: string) => {
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

// The one pass from the old model has its own tests; here every profile is already
// adopted, which is what a browser that has run this build once looks like.
vi.mock('@justfiles/fs/migrate.idb', () => ({ migrateIdb: async () => {} }))
vi.mock('@justfiles/core', () => ({ createFsClient: () => ({}) }))
vi.mock('@justfiles/fs/store.http', () => ({ httpStore: () => ({}) }))

// The loop, stood down — everything below is about what the OFFER reads and copies,
// and a running cycle would only add a peer. The volume under it is real, so
// `readFile` through the facade reads the same tree the writes land in.
vi.mock('@justfiles/fs/synced', async (original) => {
	const { storeVolume } = await import('@justfiles/fs/volume.store')
	return {
		...(await original<Record<string, unknown>>()),
		syncedVolume: async (props: Parameters<typeof storeVolume>[1] & { local: never }) => ({
			...storeVolume(props.local, { bindings: props?.bindings }),
			flush: async () => {},
			pause: () => {},
			resume: () => {},
			destroy: () => {},
			status: () => 'synced',
			onStatusChange: () => () => {},
			takeTheirs: async () => {},
			takeMine: async () => {},
			generation: () => 1
		})
	}
})

const REGISTRY_KEY = 'frieren-profiles'
const enc = new TextEncoder()
const dec = new TextDecoder()

type StoredProfile = {
	id: string
	remoteUserId?: string
	lastOpenedAt: number
	migration?: 'migrated' | 'dismissed'
}

function stubBrowser(registry: StoredProfile[]): Map<string, string> {
	const data = new Map([[REGISTRY_KEY, JSON.stringify(registry)]])
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => data.set(key, value),
		removeItem: (key: string) => data.delete(key)
	})
	vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
	vi.stubGlobal('document', {
		visibilityState: 'visible',
		addEventListener: vi.fn(),
		removeEventListener: vi.fn()
	})
	// Unique, because the STORE mints one per node: a constant would give every
	// created row the same id, and rule 3 would read each one as an overwrite of the
	// last. `subtle` is kept for the same reason — a mount row's id is a hash of its
	// position, so announcing one is the first thing every profile does.
	let minted = 0
	vi.stubGlobal('crypto', {
		randomUUID: () => `uuid-${++minted}`,
		subtle: globalThis.crypto.subtle
	})
	return data
}

// Fresh module graph + cleared stores + stubbed browser. Seed AFTER this, attach,
// then assert.
/**
 * The account profile is in every registry, and least-recently-opened, so 'local' is
 * still the current one and the account's id is a NAME this file can seed against.
 * `profileForUser` finds it rather than minting one.
 */
const registryWith = (account: Partial<StoredProfile> = {}): StoredProfile[] => [
	{ id: 'local', lastOpenedAt: 1 },
	{ id: 'account-profile', remoteUserId: 'user-1', lastOpenedAt: 0, ...account }
]

async function loadFs(registry: StoredProfile[]) {
	vi.resetModules()
	H.stores.clear()
	const data = stubBrowser(registry)
	const fs = await import('../fs')
	return { fs, data }
}

/**
 * A profile as this build leaves one: the synced tree, and its own store joined at
 * `/private` — so a path under that name is written to the OTHER database, which is
 * the whole reason the copy below cannot reach it.
 */
async function seedProfile(id: string, files: Record<string, string>): Promise<void> {
	const { idbStore } = await import('@justfiles/fs/store.idb')
	const { ROOT } = await import('@justfiles/fs/store')
	const { announceMount, storeVolume } = await import('@justfiles/fs/volume.store')
	const tree = idbStore(`frieren-store-${id}`)
	const local = idbStore(`frieren-store-${id}-${PRIVATE_MOUNT}`)
	await announceMount(tree, ROOT, PRIVATE_MOUNT)
	const vol = storeVolume(tree, { bindings: new Map([[ROOT, new Map([[PRIVATE_MOUNT, local]])]]) })
	for (const [path, body] of Object.entries(files)) {
		const dir = path.slice(0, path.lastIndexOf('/'))
		if (dir !== '') await vol.mkdir(dir, { recursive: true })
		await vol.writeFile(path, enc.encode(body))
	}
}

/** The account's SYNCED tree, unbound: what a peer would see, and nothing else. */
async function accountVolume() {
	const { idbStore } = await import('@justfiles/fs/store.idb')
	const { storeVolume } = await import('@justfiles/fs/volume.store')
	return storeVolume(idbStore('frieren-store-account-profile'))
}

async function listAccountFiles(): Promise<Set<string>> {
	const vol = await accountVolume()
	const found = new Set<string>()
	await vol.scan('/', async (path, stat) => {
		if (path !== '/' && stat.type === FileType.Regular) found.add(path)
	})
	return found
}

const SEEDED_SOUL = '---\nschema: frieren/agent-soul/v1\nseeded: true\n---\n'
const SEEDED_PROFILE = '---\nschema: frieren/user-profile/v1\nseeded: true\n---\n'

async function attach(fs: Awaited<ReturnType<typeof loadFs>>['fs']): Promise<void> {
	await fs.openProfile()
	await fs.attachRemoteUser('user-1', async () => 'token')
}

describe('local → account migration', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-05-31T00:00:00Z'))
	})
	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllGlobals()
	})

	test('offers when local has content and the account is fresh', async () => {
		const { fs } = await loadFs(registryWith())
		await seedProfile('local', { '/notes/a.txt': 'hi', '/data/app/x.bin': 'z' })
		await attach(fs)
		expect(await fs.shouldOfferMigration()).toBe(true)
	})

	test('does not offer when the local profile has no user content', async () => {
		const { fs } = await loadFs(registryWith())
		await seedProfile('local', {
			'/system/agents/main/soul.md': SEEDED_SOUL,
			'/system/user.md': SEEDED_PROFILE,
			'/applications/paint/app.js': 'x'
		})
		await attach(fs)
		expect(await fs.shouldOfferMigration()).toBe(false)
	})

	test('does not offer when the account already has data', async () => {
		const { fs } = await loadFs(registryWith())
		await seedProfile('local', { '/notes/a.txt': 'hi' })
		await seedProfile('account-profile', { '/notes/existing.txt': 'from another device' })
		await attach(fs)
		expect(await fs.shouldOfferMigration()).toBe(false)
	})

	test('personalized soul counts as content even with no /data or /notes', async () => {
		const { fs } = await loadFs(registryWith())
		await seedProfile('local', {
			'/system/agents/main/soul.md': '---\nagent_name: Custom\n---\nYou are custom.\n',
			'/system/user.md': SEEDED_PROFILE
		})
		await attach(fs)
		expect(await fs.shouldOfferMigration()).toBe(true)
	})

	test('does not offer once a decision is recorded', async () => {
		const { fs } = await loadFs(registryWith({ migration: 'dismissed' }))
		await seedProfile('local', { '/notes/a.txt': 'hi' })
		await attach(fs)
		expect(await fs.shouldOfferMigration()).toBe(false)
	})

	test('copies user data + identity, skips journal/private/apps/state', async () => {
		const { fs } = await loadFs(registryWith())
		await seedProfile('local', {
			'/notes/a.txt': 'note body',
			'/data/justfiles.paint/drawing.bin': 'pixels',
			'/system/agents/main/soul.md': '---\nagent_name: Custom\n---\nsoul\n',
			'/system/user.md': '---\nname: Xiao\n---\n',
			'/system/os-state.json': '{"windows":{}}',
			'/private/accounts/frieren.json': 'secret',
			'/private/active-ai.json': '{"accountId":"u@openai.com"}',
			'/.state/clientid': 'uuid',
			'/applications/paint/app.js': 'code',
			'/state/justfiles.paint.json': '{}'
		})
		await attach(fs)

		await fs.migrateLocalProfileInto()

		const files = await listAccountFiles()
		expect(files).toContain('/notes/a.txt')
		expect(files).toContain('/data/justfiles.paint/drawing.bin')
		expect(files).toContain('/system/agents/main/soul.md')
		expect(files).toContain('/system/user.md')
		expect(files).toContain('/system/os-state.json')
		expect(files).not.toContain('/private/accounts/frieren.json')
		expect(files).not.toContain('/private/active-ai.json')
		expect(files).not.toContain('/.state/clientid')
		expect(files).not.toContain('/applications/paint/app.js')
		expect(files).not.toContain('/state/justfiles.paint.json')
		expect(dec.decode(await (await accountVolume()).readFile('/notes/a.txt'))).toBe('note body')
	})

	test('does not clobber account content created/synced after the offer', async () => {
		const { fs } = await loadFs(registryWith())
		await seedProfile('local', { '/notes/a.txt': 'local-a', '/notes/b.txt': 'local-b' })
		await attach(fs)
		// The account gains a file at the same path after the offer was shown.
		await seedProfile('account-profile', { '/notes/a.txt': 'account-a' })

		await fs.migrateLocalProfileInto()

		const vol = await accountVolume()
		expect(dec.decode(await vol.readFile('/notes/a.txt'))).toBe('account-a') // preserved
		expect(dec.decode(await vol.readFile('/notes/b.txt'))).toBe('local-b') // brought over
	})

	test('replaces a seeded account identity with the personalized local one', async () => {
		const { fs } = await loadFs(registryWith())
		await seedProfile('local', {
			'/system/agents/main/soul.md': '---\nagent_name: Custom\n---\npersonalized\n'
		})
		await attach(fs)
		await seedProfile('account-profile', { '/system/agents/main/soul.md': SEEDED_SOUL })

		await fs.migrateLocalProfileInto()

		expect(
			dec.decode(await (await accountVolume()).readFile('/system/agents/main/soul.md'))
		).toContain('personalized')
	})

	test('keeps a personalized account identity over the local one', async () => {
		const { fs } = await loadFs(registryWith())
		await seedProfile('local', {
			'/system/agents/main/soul.md': '---\nagent_name: Local\n---\nlocal soul\n'
		})
		await attach(fs)
		await seedProfile('account-profile', {
			'/system/agents/main/soul.md': '---\nagent_name: Account\n---\naccount soul\n'
		})

		await fs.migrateLocalProfileInto()

		expect(
			dec.decode(await (await accountVolume()).readFile('/system/agents/main/soul.md'))
		).toContain('account soul')
	})

	test('migrate records the decision so the offer never repeats', async () => {
		const { fs, data } = await loadFs(registryWith())
		await seedProfile('local', { '/notes/a.txt': 'hi' })
		await attach(fs)
		await fs.migrateLocalProfileInto()
		const registry = JSON.parse(data.get(REGISTRY_KEY) ?? '[]') as StoredProfile[]
		expect(registry.find((p) => p.id === 'account-profile')?.migration).toBe('migrated')
		expect(await fs.shouldOfferMigration()).toBe(false)
	})

	test('dismiss records the decision', async () => {
		const { fs, data } = await loadFs(registryWith())
		await seedProfile('local', { '/notes/a.txt': 'hi' })
		await attach(fs)
		fs.dismissMigration()
		const registry = JSON.parse(data.get(REGISTRY_KEY) ?? '[]') as StoredProfile[]
		expect(registry.find((p) => p.id === 'account-profile')?.migration).toBe('dismissed')
		expect(await fs.shouldOfferMigration()).toBe(false)
	})
})
