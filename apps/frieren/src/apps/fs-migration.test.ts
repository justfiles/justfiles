import { FileType } from '@justfiles/fs/types'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// A minimal in-memory FS, fully hand-rolled (like profile-session.test.ts) so no
// real `@justfiles/fs` is pulled — partially mocking that package deadlocks the
// runner. One store per db name, shared between the module under test and the
// harness so a seeded source profile and the account are the same bytes.
const H = vi.hoisted(() => {
	type Store = { files: Map<string, Uint8Array>; dirs: Set<string>; destroy: () => void }
	const stores = new Map<string, Store>()
	const depth = (p: string) => (p === '/' ? 0 : p.split('/').filter(Boolean).length)
	const ancestors = (p: string): string[] => {
		const parts = p.split('/').filter(Boolean)
		const out: string[] = []
		let cur = ''
		for (let i = 0; i < parts.length - 1; i++) {
			cur += `/${parts[i]}`
			out.push(cur)
		}
		return out
	}
	const newStore = (): Store => ({ files: new Map(), dirs: new Set(), destroy: () => {} })
	const getStore = (name: string): Store => {
		let s = stores.get(name)
		if (!s) {
			s = newStore()
			stores.set(name, s)
		}
		return s
	}
	const makeVolume = (store: Store) => ({
		async readdir(path: string) {
			const prefix = path === '/' ? '/' : `${path}/`
			const seen = new Map<string, number>()
			const add = (full: string, type: number) => {
				if (full === path || !full.startsWith(prefix)) return
				const rest = full.slice(prefix.length)
				if (rest.includes('/') || rest === '') return
				if (!seen.has(rest)) seen.set(rest, type)
			}
			for (const d of store.dirs) add(d, FileType.Directory)
			for (const f of store.files.keys()) add(f, FileType.Regular)
			return [...seen].map(([name, type]) => ({ name, type, ino: name }))
		},
		async exists(path: string) {
			return store.files.has(path) || store.dirs.has(path)
		},
		async readFile(path: string) {
			const b = store.files.get(path)
			if (!b) throw new Error(`ENOENT: ${path}`)
			return b
		},
		async writeFile(path: string, data: Uint8Array) {
			for (const a of ancestors(path)) store.dirs.add(a)
			store.files.set(path, data)
		},
		async mkdir(path: string) {
			store.dirs.add(path)
			for (const a of ancestors(path)) store.dirs.add(a)
		},
		async scan(root: string, visitor: (p: string, stat: { type: number }) => Promise<void>) {
			const prefix = root === '/' ? '/' : `${root}/`
			const all = new Set<string>([root])
			for (const d of store.dirs) if (d === root || d.startsWith(prefix)) all.add(d)
			for (const f of store.files.keys()) if (f === root || f.startsWith(prefix)) all.add(f)
			const sorted = [...all].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
			for (const p of sorted)
				await visitor(p, { type: store.files.has(p) ? FileType.Regular : FileType.Directory })
		}
	})
	return { stores, getStore, newStore, makeVolume }
})

vi.mock('@justfiles/core', () => ({ remoteSyncReplica: () => ({}), createFsClient: () => ({}) }))

vi.mock('@justfiles/fs/storage/idb', () => ({ idbStorage: (name: string) => H.getStore(name) }))

vi.mock('@justfiles/fs', () => ({
	memStorage: () => H.newStore(),
	volume: (store: Parameters<typeof H.makeVolume>[0]) => H.makeVolume(store),
	synced: async ({ local }: { local: Parameters<typeof H.makeVolume>[0] }) => {
		const v = H.makeVolume(local)
		return {
			readFile: v.readFile,
			flush: async () => {},
			pause: () => {},
			resume: () => {},
			destroy: () => {},
			generation: () => 1,
			status: () => 'synced',
			onStatusChange: () => () => {}
		}
	}
}))

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
		setItem: (key: string, value: string) => data.set(key, value)
	})
	vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
	vi.stubGlobal('document', {
		visibilityState: 'visible',
		addEventListener: vi.fn(),
		removeEventListener: vi.fn()
	})
	vi.stubGlobal('crypto', { randomUUID: () => 'account-profile' })
	return data
}

// Fresh module graph + cleared stores + stubbed browser. Seed AFTER this, attach,
// then assert.
async function loadFs(registry: StoredProfile[]) {
	vi.resetModules()
	H.stores.clear()
	const data = stubBrowser(registry)
	const fs = await import('../fs')
	return { fs, data }
}

async function seedProfile(id: string, files: Record<string, string>): Promise<void> {
	const { idbStorage } = await import('@justfiles/fs/storage/idb')
	const { volume } = await import('@justfiles/fs')
	const vol = volume(idbStorage(`frieren-fs-profile-${id}`) as never)
	for (const [path, body] of Object.entries(files)) await vol.writeFile(path, enc.encode(body))
}

async function accountVolume() {
	const { idbStorage } = await import('@justfiles/fs/storage/idb')
	const { volume } = await import('@justfiles/fs')
	return volume(idbStorage('frieren-fs-profile-account-profile') as never)
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
		const { fs } = await loadFs([{ id: 'local', lastOpenedAt: 1 }])
		await seedProfile('local', { '/notes/a.txt': 'hi', '/data/app/x.bin': 'z' })
		await attach(fs)
		expect(await fs.shouldOfferMigration()).toBe(true)
	})

	test('does not offer when the local profile has no user content', async () => {
		const { fs } = await loadFs([{ id: 'local', lastOpenedAt: 1 }])
		await seedProfile('local', {
			'/system/agents/main/soul.md': SEEDED_SOUL,
			'/system/user.md': SEEDED_PROFILE,
			'/applications/paint/app.js': 'x'
		})
		await attach(fs)
		expect(await fs.shouldOfferMigration()).toBe(false)
	})

	test('does not offer when the account already has data', async () => {
		const { fs } = await loadFs([{ id: 'local', lastOpenedAt: 1 }])
		await seedProfile('local', { '/notes/a.txt': 'hi' })
		await seedProfile('account-profile', { '/notes/existing.txt': 'from another device' })
		await attach(fs)
		expect(await fs.shouldOfferMigration()).toBe(false)
	})

	test('personalized soul counts as content even with no /data or /notes', async () => {
		const { fs } = await loadFs([{ id: 'local', lastOpenedAt: 1 }])
		await seedProfile('local', {
			'/system/agents/main/soul.md': '---\nagent_name: Custom\n---\nYou are custom.\n',
			'/system/user.md': SEEDED_PROFILE
		})
		await attach(fs)
		expect(await fs.shouldOfferMigration()).toBe(true)
	})

	test('does not offer once a decision is recorded', async () => {
		const { fs } = await loadFs([
			{ id: 'local', lastOpenedAt: 1 },
			{ id: 'account-profile', remoteUserId: 'user-1', lastOpenedAt: 2, migration: 'dismissed' }
		])
		await seedProfile('local', { '/notes/a.txt': 'hi' })
		await attach(fs)
		expect(await fs.shouldOfferMigration()).toBe(false)
	})

	test('copies user data + identity, skips journal/private/apps/state', async () => {
		const { fs } = await loadFs([{ id: 'local', lastOpenedAt: 1 }])
		await seedProfile('local', {
			'/notes/a.txt': 'note body',
			'/data/app.justfiles.frieren.paint/drawing.bin': 'pixels',
			'/system/agents/main/soul.md': '---\nagent_name: Custom\n---\nsoul\n',
			'/system/user.md': '---\nname: Xiao\n---\n',
			'/system/os-state.json': '{"windows":{}}',
			'/private/accounts/frieren.json': 'secret',
			'/private/active-ai.json': '{"accountId":"u@openai.com"}',
			'/.state/clientid': 'uuid',
			'/applications/paint/app.js': 'code',
			'/state/app.justfiles.frieren.paint.json': '{}'
		})
		await attach(fs)

		await fs.migrateLocalProfileInto()

		const files = await listAccountFiles()
		expect(files).toContain('/notes/a.txt')
		expect(files).toContain('/data/app.justfiles.frieren.paint/drawing.bin')
		expect(files).toContain('/system/agents/main/soul.md')
		expect(files).toContain('/system/user.md')
		expect(files).toContain('/system/os-state.json')
		expect(files).not.toContain('/private/accounts/frieren.json')
		expect(files).not.toContain('/private/active-ai.json')
		expect(files).not.toContain('/.state/clientid')
		expect(files).not.toContain('/applications/paint/app.js')
		expect(files).not.toContain('/state/app.justfiles.frieren.paint.json')
		expect(dec.decode(await (await accountVolume()).readFile('/notes/a.txt'))).toBe('note body')
	})

	test('does not clobber account content created/synced after the offer', async () => {
		const { fs } = await loadFs([{ id: 'local', lastOpenedAt: 1 }])
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
		const { fs } = await loadFs([{ id: 'local', lastOpenedAt: 1 }])
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
		const { fs } = await loadFs([{ id: 'local', lastOpenedAt: 1 }])
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
		const { fs, data } = await loadFs([{ id: 'local', lastOpenedAt: 1 }])
		await seedProfile('local', { '/notes/a.txt': 'hi' })
		await attach(fs)
		await fs.migrateLocalProfileInto()
		const registry = JSON.parse(data.get(REGISTRY_KEY) ?? '[]') as StoredProfile[]
		expect(registry.find((p) => p.id === 'account-profile')?.migration).toBe('migrated')
		expect(await fs.shouldOfferMigration()).toBe(false)
	})

	test('dismiss records the decision', async () => {
		const { fs, data } = await loadFs([{ id: 'local', lastOpenedAt: 1 }])
		await seedProfile('local', { '/notes/a.txt': 'hi' })
		await attach(fs)
		fs.dismissMigration()
		const registry = JSON.parse(data.get(REGISTRY_KEY) ?? '[]') as StoredProfile[]
		expect(registry.find((p) => p.id === 'account-profile')?.migration).toBe('dismissed')
		expect(await fs.shouldOfferMigration()).toBe(false)
	})
})
