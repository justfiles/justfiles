import type { Volume } from '@justfiles/fs'
import { describe, expect, test, vi } from 'vitest'
import {
	type AppStore,
	type CatalogApp,
	installApp,
	materialise,
	reconcile,
	semverGte
} from './appstore.ts'
import type { AppBundle, AppManifest, Kernel } from './kernel.ts'

const enc = new TextEncoder()

const FILES: Record<string, string> = {
	'manifest.json': JSON.stringify({ id: 'app.x', name: 'X', version: '1.0.0', app: 'app.js' }),
	'app.js': '// code'
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const buffer = bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength
	) as ArrayBuffer
	const digest = await crypto.subtle.digest('SHA-256', buffer)
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Built-ins are HOSTED: the deploy serves their files at an immutable version-pathed
// URL, so they install as a spec. `baseUrl: null` models a store whose bytes have no
// stable address (a packaged FS bundle), whose apps are copied into the volume.
async function catalogApp(
	id: string,
	files: Record<string, string>,
	baseUrl: string | null = '/appstore/apps'
): Promise<CatalogApp> {
	const fileList = await Promise.all(
		Object.entries(files).map(async ([path, content]) => ({
			path,
			hash: `sha256-${await sha256Hex(enc.encode(content))}`,
			size: enc.encode(content).byteLength
		}))
	)
	// Mirror the store: the catalog version is the app's declared manifest version.
	const version = (JSON.parse(files['manifest.json'] ?? '{}') as { version?: string }).version
	return {
		id,
		name: id,
		version: version ?? '1.0.0',
		icon: 'icon.svg',
		files: fileList,
		...(baseUrl ? { baseUrl: `${baseUrl}/${id}/${version ?? '1.0.0'}` } : {})
	}
}

// A store carrying one built-in whose pinned hashes match the bytes `read`
// returns — so the integrity check passes and reconcile compares real digests.
async function builtinStore(
	files: Record<string, string>,
	baseUrl: string | null = '/appstore/apps'
): Promise<AppStore> {
	const app = await catalogApp('app.x', files, baseUrl)
	return {
		async builtins() {
			return [app]
		},
		async latest(id) {
			return id === app.id ? app : null
		},
		async read(_app, path) {
			return enc.encode(files[path] ?? '')
		}
	}
}

// A store for `app.x` at `version` with byte-identical app.js across versions —
// so only manifest.json (which carries the version) differs between releases.
async function versionedStore(version: string): Promise<AppStore> {
	return builtinStore({
		'manifest.json': JSON.stringify({ id: 'app.x', name: 'X', version, app: 'app.js' }),
		'app.js': '// code'
	})
}

// A tiny in-memory app bundle, for pre-seeding an "already installed" app.
function bundle(files: Record<string, string>): AppBundle {
	return {
		manifest: async () => JSON.parse(files['manifest.json'] ?? '{}'),
		list: async function* () {
			yield* Object.keys(files)
		},
		read: async (path: string) => enc.encode(files[path] ?? '')
	}
}

// One in-memory world: kernel.install writes the bundle's files into the volume
// (verbatim, like the real kernel), kernel.uninstall drops an app's files, and
// volume.stat reports each file's sha256 — so reconcile's content comparison
// sees exactly what was installed. `blobs` is exposed so a test can simulate a
// lost/un-hydrated file.
function fakeWorld(serve?: (path: string) => Uint8Array) {
	const blobs = new Map<string, Uint8Array>() // volume path -> bytes
	const hostCache = new Map<string, Uint8Array>()
	const installs: string[] = []
	const requested: string[] = []
	const kernel = {
		// Models the browser host: `fetchAsset` is fronted by a cache keyed by the
		// immutable release URL. The app layer itself owns no cached volume bytes.
		app: async (id: string) => {
			const record = blobs.get(`/applications/${id}/manifest.json`)
			if (!record) throw new Error(`not installed: ${id}`)
			const manifest = JSON.parse(new TextDecoder().decode(record)) as AppManifest
			return {
				manifest,
				read: async (path: string) => {
					const at = `${manifest.baseUrl}/${path}`
					const cached = hostCache.get(at)
					if (cached) return cached
					requested.push(path)
					if (!serve) throw new Error(`offline: ${path}`)
					const bytes = serve(path)
					hostCache.set(at, bytes)
					return bytes
				}
			}
		},
		list: async (): Promise<AppManifest[]> => {
			const ids = new Set<string>()
			for (const path of blobs.keys()) {
				const id = path.match(/^\/applications\/([^/]+)\//)?.[1]
				if (id) ids.add(id)
			}
			return [...ids].map((id) => ({ id, name: id, version: '1.0.0', app: 'app.js' }))
		},
		install: async (b: AppBundle): Promise<string> => {
			const manifest = await b.manifest()
			installs.push(manifest.id)
			// Like the real kernel: the whole app root is REPLACED, so a file the new
			// bundle does not stage is gone — which is what makes the migration off the
			// copied layout free. A hosted bundle stages nothing but its record.
			for (const path of [...blobs.keys()])
				if (path.match(/^\/applications\/([^/]+)\//)?.[1] === manifest.id) blobs.delete(path)
			for await (const path of b.list()) {
				blobs.set(`/applications/${manifest.id}/${path}`, await b.read(path))
			}
			blobs.set(`/applications/${manifest.id}/manifest.json`, enc.encode(JSON.stringify(manifest)))
			return manifest.id
		},
		uninstall: async (id: string): Promise<void> => {
			for (const path of [...blobs.keys()])
				if (path.match(/^\/applications\/([^/]+)\//)?.[1] === id) blobs.delete(path)
		}
	} as unknown as Kernel
	const fs = {
		stat: async (path: string) => {
			const bytes = blobs.get(path)
			if (!bytes) throw new Error(`ENOENT: ${path}`)
			return { contentHash: await sha256Hex(bytes) }
		},
		readFile: async (path: string) => {
			const bytes = blobs.get(path)
			if (!bytes) throw new Error(`ENOENT: ${path}`)
			return bytes
		}
	} as unknown as Volume
	return { kernel, fs, installs, blobs, requested }
}

describe('materialise', () => {
	test('seeds a missing built-in', async () => {
		const store = await builtinStore(FILES)
		const { kernel, installs } = fakeWorld()
		await materialise(kernel, store)
		expect(installs).toEqual(['app.x'])
	})

	test('skips a built-in that is already installed (idempotent)', async () => {
		const store = await builtinStore(FILES)
		const { kernel, installs } = fakeWorld()
		await materialise(kernel, store)
		await materialise(kernel, store)
		expect(installs).toEqual(['app.x']) // installed once, then left alone
	})

	test('rejects bytes that do not match the pinned hash, before installing', async () => {
		// The copy path verifies as it downloads. (A hosted app has nothing to verify at
		// install — its bytes are checked against the record's hashes when they mount.)
		const store = await builtinStore(FILES, null)
		const { kernel, installs } = fakeWorld()
		store.read = async (_app, path) =>
			enc.encode(path === 'app.js' ? '// tampered' : (FILES[path] ?? ''))
		await expect(materialise(kernel, store)).rejects.toThrow(/hash/)
		expect(installs).toEqual([])
	})

	test('a failed hosted built-in does not stop the others', async () => {
		const first = await catalogApp('app.x', FILES)
		first.manifest = { id: first.id, name: first.name, app: 'app.js' }
		const second = {
			...first,
			id: 'app.y',
			baseUrl: '/appstore/apps/app.y/1.0.0',
			manifest: { id: 'app.y', name: 'app.y', app: 'app.js' }
		}
		const store: AppStore = {
			async builtins() {
				return [first, second]
			},
			async latest() {
				return null
			},
			async read(app, path) {
				if (app.id === first.id) throw new Error('offline')
				return enc.encode(FILES[path] ?? '')
			}
		}
		const { kernel, installs } = fakeWorld()
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

		try {
			await materialise(kernel, store)
			expect(warn).toHaveBeenCalledWith('appstore: install failed for app.x', expect.any(Error))
		} finally {
			warn.mockRestore()
		}

		expect(installs).toEqual(['app.y'])
	})
})

test('a canonical hosted release persists its manifest and reducer only', async () => {
	const payload = { 'app.js': '// reducer', 'gui.js': '// gui' }
	const files = await Promise.all(
		Object.entries(payload).map(async ([path, content]) => ({
			path,
			hash: `sha256-${await sha256Hex(enc.encode(content))}`,
			size: enc.encode(content).byteLength
		}))
	)
	const app: CatalogApp = {
		id: 'app.x',
		name: 'X',
		version: '1.0.0',
		baseUrl: 'https://app.x.justapps.run/v/1.0.0/',
		hash: 'runner-release-hash',
		manifest: { id: 'app.x', name: 'X', version: '1.0.0', app: 'app.js', gui: 'gui.js' },
		files
	}
	const store: AppStore = {
		async builtins() {
			return []
		},
		async latest() {
			return app
		},
		async read(_app, path) {
			return enc.encode(payload[path as keyof typeof payload])
		}
	}
	const world = fakeWorld((path) => enc.encode(payload[path as keyof typeof payload]))

	await Promise.all([
		installApp(world.kernel, store, app),
		installApp(world.kernel, store, app) // the volume watcher may reconcile mid-install
	])

	expect(world.installs).toEqual(['app.x'])
	expect(new TextDecoder().decode(world.blobs.get('/applications/app.x/app.js')!)).toBe(
		'// reducer'
	)
	expect(world.blobs.has('/applications/app.x/gui.js')).toBe(false)
	const installed = JSON.parse(
		new TextDecoder().decode(world.blobs.get('/applications/app.x/manifest.json')!)
	) as AppManifest
	expect(installed).toMatchObject({
		baseUrl: app.baseUrl,
		hash: app.hash,
		files: { 'gui.js': files[1]?.hash }
	})
	expect(world.requested).toEqual(['gui.js'])

	await reconcile(world.kernel, world.fs, store)
	expect(world.installs).toEqual(['app.x'])
})

describe('reconcile', () => {
	test('skips a built-in whose assets already match', async () => {
		const store = await builtinStore(FILES)
		const { kernel, fs, installs } = fakeWorld()
		await materialise(kernel, store)
		await reconcile(kernel, fs, store)
		expect(installs).toEqual(['app.x']) // seeded once, then skipped (unchanged)
	})

	test('upgrades a built-in whose assets changed', async () => {
		const v1 = await builtinStore(FILES)
		const v2 = await builtinStore({ ...FILES, 'app.js': '// code v2' })
		const { kernel, fs, installs } = fakeWorld()
		await materialise(kernel, v1)
		await reconcile(kernel, fs, v2)
		expect(installs).toEqual(['app.x', 'app.x']) // changed bytes → reinstalled
	})

	test('upgrades a built-in whose version bumped even if other assets are identical', async () => {
		// A pure version bump: app.js is byte-identical, only manifest.json changes.
		const { kernel, fs, installs } = fakeWorld()
		await materialise(kernel, await versionedStore('1.0.0'))
		await reconcile(kernel, fs, await versionedStore('1.1.0'))
		expect(installs).toEqual(['app.x', 'app.x']) // version bump → reinstalled
	})

	test('reinstalls a copied app when a file is missing even if the hash matches', async () => {
		// Self-heal for bytes that live IN the volume. A hosted app needs no equivalent:
		// its payload is hosted, and a miss is refilled by the read that wants it.
		const store = await builtinStore(FILES, null)
		const { kernel, fs, installs, blobs } = fakeWorld()
		await materialise(kernel, store)
		blobs.delete('/applications/app.x/app.js') // a lost / un-hydrated file
		await reconcile(kernel, fs, store)
		expect(installs).toEqual(['app.x', 'app.x']) // self-healed
	})

	test('does not reinstall when the store version is older than installed', async () => {
		const { kernel, fs, installs } = fakeWorld()
		await materialise(kernel, await versionedStore('0.1.1')) // installed 0.1.1
		await reconcile(kernel, fs, await versionedStore('0.1.0')) // stale build offers 0.1.0
		expect(installs).toEqual(['app.x']) // no downgrade
	})

	test('does not downgrade via repair when an older store also changed the files', async () => {
		// The repair path is monotonic too: a stale store whose files differ must not
		// masquerade as a self-heal and reinstall its OLDER bytes over a newer install.
		const newer = await builtinStore({
			'manifest.json': JSON.stringify({ id: 'app.x', name: 'X', version: '2.0.0', app: 'app.js' }),
			'app.js': '// code v2'
		})
		const older = await builtinStore({
			'manifest.json': JSON.stringify({ id: 'app.x', name: 'X', version: '1.0.0', app: 'app.js' }),
			'app.js': '// code v1'
		})
		const { kernel, fs, installs } = fakeWorld()
		await materialise(kernel, newer)
		await reconcile(kernel, fs, older)
		expect(installs).toEqual(['app.x']) // no downgrade
	})

	test('a deleted built-in is not force-reinstalled', async () => {
		const store = await builtinStore(FILES)
		const { kernel, fs, installs } = fakeWorld()
		await materialise(kernel, store)
		await kernel.uninstall('app.x') // user removes it
		await reconcile(kernel, fs, store)
		expect(installs).toEqual(['app.x']) // NOT reinstalled
	})

	test('updates an installed non-built-in app via latest(id)', async () => {
		const { kernel, fs, installs } = fakeWorld()
		// A third-party app is already on the volume (older bytes) and NOT a built-in.
		const old = {
			'manifest.json': JSON.stringify({ id: 'app.z', name: 'Z', version: '1.0.0', app: 'app.js' }),
			'app.js': '// z v1'
		}
		await kernel.install(bundle(old))
		const next = await catalogApp('app.z', { ...old, 'app.js': '// z v2' })
		const store: AppStore = {
			async builtins() {
				return []
			},
			async latest(id) {
				return id === 'app.z' ? next : null
			},
			async read(_app, path) {
				return enc.encode(path === 'app.js' ? '// z v2' : (old[path] ?? ''))
			}
		}
		await reconcile(kernel, fs, store)
		expect(installs).toEqual(['app.z', 'app.z']) // seeded, then updated via latest()
	})

	test('one failing app does not block the others, and retries next pass', async () => {
		const { kernel, fs, installs } = fakeWorld()
		const files = (id: string, version: string) => ({
			'manifest.json': JSON.stringify({ id, name: id, version, app: 'app.js' }),
			'app.js': `// ${id} ${version}`
		})
		await kernel.install(bundle(files('app.a', '1.0.0')))
		await kernel.install(bundle(files('app.b', '1.0.0')))
		installs.length = 0 // only count what reconcile does
		const next = new Map(
			await Promise.all(
				['app.a', 'app.b'].map(
					async (id) => [id, await catalogApp(id, files(id, '2.0.0'))] as const
				)
			)
		)
		let failing = true
		const store: AppStore = {
			builtins: async () => [],
			latest: async (id) => next.get(id) ?? null,
			read: async (app, path) => {
				// app.a is unavailable on the first pass (CDN down); app.b is fine.
				if (app.id === 'app.a' && failing) throw new Error('502')
				return enc.encode(files(app.id, '2.0.0')[path] ?? '')
			}
		}
		await reconcile(kernel, fs, store)
		expect(installs).toEqual(['app.b']) // app.a failed, app.b still updated

		failing = false
		await reconcile(kernel, fs, store) // the next checkpoint IS the retry
		expect(installs).toEqual(['app.b', 'app.a'])
	})
})

// #376: a built-in's payload is served by the deploy, so it installs as a SPEC —
// `/applications/<id>` holds the record alone and the bytes are mounted from the
// origin. The mount itself lives in the kernel; what reconcile owns is deciding when
// an installed record has to be replaced.
describe('hosted apps', () => {
	const GUI_FILES: Record<string, string> = {
		'manifest.json': JSON.stringify({
			id: 'app.x',
			name: 'X',
			version: '1.0.0',
			app: 'app.js',
			gui: 'gui.js'
		}),
		'app.js': '// reducer',
		'gui.js': '// gui'
	}

	test('a hosted install writes the record and the reducer', async () => {
		const { kernel, fs, blobs } = fakeWorld()
		await materialise(kernel, await builtinStore(GUI_FILES))

		// The reducer stays in the volume — a headless kernel runs it with no origin to
		// reach — and the GUI does not.
		expect([...blobs.keys()].sort()).toEqual([
			'/applications/app.x/app.js',
			'/applications/app.x/manifest.json'
		])
		const manifest = JSON.parse(
			new TextDecoder().decode(await fs.readFile('/applications/app.x/manifest.json'))
		)
		expect(manifest.baseUrl).toBe('/appstore/apps/app.x/1.0.0')
		// The record carries what a device needs to fetch and verify the rest on its own.
		expect(manifest.version).toBe('1.0.0')
		expect(typeof manifest.hash).toBe('string')
		// Only what actually mounts: pinning the reducer would describe a fetch that
		// never happens.
		expect(Object.keys(manifest.files)).toEqual(['gui.js'])
		expect(manifest.files['gui.js']).toMatch(/^sha256-/)
	})

	test('two requests, not one per file', async () => {
		// The record and the reducer; the rest is the origin's to serve later. The old
		// path downloaded every file up front.
		const store = await builtinStore(GUI_FILES)
		const read: string[] = []
		const spy = {
			...store,
			read(a: CatalogApp, p: string) {
				read.push(p)
				return store.read(a, p)
			}
		}
		const { kernel } = fakeWorld()
		await materialise(kernel, spy)
		expect(read.sort()).toEqual(['app.js', 'manifest.json'])
	})

	test('a hosted app is repaired when its reducer goes missing', async () => {
		// The half that lives in the volume still self-heals: it is the half that cannot
		// be refetched by a read.
		const { kernel, fs, installs, blobs } = fakeWorld()
		const store = await builtinStore(GUI_FILES)
		await materialise(kernel, store)
		blobs.delete('/applications/app.x/app.js')
		await reconcile(kernel, fs, store)
		expect(installs).toEqual(['app.x', 'app.x'])
		expect(blobs.has('/applications/app.x/app.js')).toBe(true)
	})

	// The migration, and why it cannot ride on the version. A release that only changes
	// PACKAGING leaves version and whole-app hash untouched, so every other signal
	// `decide` reads says 'skip' — the app would stay copied forever.
	test('an app installed as copied bytes is reinstalled as a record', async () => {
		const { kernel, fs, installs, blobs } = fakeWorld()
		await materialise(kernel, await builtinStore(GUI_FILES, null)) // the old shape
		expect(blobs.has('/applications/app.x/gui.js')).toBe(true)
		installs.length = 0

		// Same version, same files — only the store now serves them from an origin.
		await reconcile(kernel, fs, await builtinStore(GUI_FILES))

		expect(installs).toEqual(['app.x'])
		// `kernel.install` replaces the whole app root, so the GUI's copy is gone and that
		// delete propagates: the DO's storage shrinks with no migration code.
		expect([...blobs.keys()].sort()).toEqual([
			'/applications/app.x/app.js',
			'/applications/app.x/manifest.json'
		])
	})

	test('the migration happens once — the next pass skips', async () => {
		const { kernel, fs, installs } = fakeWorld()
		const hosted = await builtinStore(GUI_FILES)
		await materialise(kernel, await builtinStore(GUI_FILES, null))
		installs.length = 0
		await reconcile(kernel, fs, hosted)
		await reconcile(kernel, fs, hosted)
		expect(installs).toEqual(['app.x'])
	})

	test('a hosted app is not reinstalled for bytes that are not in the volume', async () => {
		// The payload's absence is normal, not damage — `filesPresentAndMatch` would
		// otherwise see every file missing and reinstall on every single pass.
		const { kernel, fs, installs } = fakeWorld()
		const store = await builtinStore(GUI_FILES)
		await materialise(kernel, store)
		await reconcile(kernel, fs, store)
		await reconcile(kernel, fs, store)
		expect(installs).toEqual(['app.x'])
	})

	test('a newer record is never replaced by an older release’s catalog', async () => {
		// The monotonic guard still holds across the structural trigger: a device whose
		// own release is behind must not rewrite a record a peer installed.
		const newer = { ...GUI_FILES }
		newer['manifest.json'] = JSON.stringify({
			id: 'app.x',
			name: 'X',
			version: '2.0.0',
			app: 'app.js',
			gui: 'gui.js'
		})
		const { kernel, fs, installs } = fakeWorld()
		await materialise(kernel, await builtinStore(newer, null)) // copied, at v2
		installs.length = 0
		await reconcile(kernel, fs, await builtinStore(GUI_FILES)) // hosted, but only v1
		expect(installs).toEqual([])
	})

	test('a release that only MOVES is still reinstalled', async () => {
		// The whole-app hash covers file paths and digests, so relocating an otherwise
		// identical release leaves it equal — and the record would stay pointed at an
		// origin the store no longer serves from, with nothing to notice.
		const { kernel, fs, installs, blobs } = fakeWorld()
		await materialise(kernel, await builtinStore(GUI_FILES))
		installs.length = 0

		await reconcile(kernel, fs, await builtinStore(GUI_FILES, 'https://apps.example.com'))

		expect(installs).toEqual(['app.x'])
		const manifest = JSON.parse(
			new TextDecoder().decode(blobs.get('/applications/app.x/manifest.json'))
		)
		expect(manifest.baseUrl).toBe('https://apps.example.com/app.x/1.0.0')
	})

	test('a hosted release the store no longer hosts goes back to copied bytes', async () => {
		const { kernel, fs, installs, blobs } = fakeWorld()
		await materialise(kernel, await builtinStore(GUI_FILES))
		installs.length = 0

		await reconcile(kernel, fs, await builtinStore(GUI_FILES, null))

		expect(installs).toEqual(['app.x'])
		expect(blobs.has('/applications/app.x/gui.js')).toBe(true)
	})

	test('a store that cannot re-serve its apps still copies them in', async () => {
		// A packaged FS bundle (the Mac daemon's built-ins) has no stable address, and a
		// locally-authored app has no upstream at all. Both keep every byte in the volume.
		const { kernel, fs, installs, blobs } = fakeWorld()
		await materialise(kernel, await builtinStore(GUI_FILES, null))
		await reconcile(kernel, fs, await builtinStore(GUI_FILES, null))

		expect(installs).toEqual(['app.x'])
		expect(blobs.has('/applications/app.x/gui.js')).toBe(true)
		expect([...blobs.keys()].some((p) => p.startsWith('/private/'))).toBe(false)
	})
})

describe('semverGte', () => {
	test('compares numerically, not lexicographically', () => {
		expect(semverGte('0.10.0', '0.9.0')).toBe(true) // 10 > 9
		expect(semverGte('1.0.0', '1.0.0')).toBe(true) // equal is >=
		expect(semverGte('1.0.0', '1.0.1')).toBe(false)
		expect(semverGte('2.0.0', '1.9.9')).toBe(true)
		expect(semverGte('1.2', '1.2.0')).toBe(true) // missing segment = 0
		expect(semverGte('0.0.0', '1.0.0')).toBe(false) // versionless install is oldest
	})
})

// ── fast-follow prefetch ─────────────────────────────────────────────────────

// A hosted app with something to mount. `files` on the record is everything but
// manifest.json and the reducer, so an app without a GUI mounts nothing at all.
const HOSTED: Record<string, string> = {
	'manifest.json': JSON.stringify({
		id: 'app.x',
		name: 'X',
		version: '1.0.0',
		app: 'app.js',
		gui: 'gui.js'
	}),
	'app.js': '// code',
	'gui.js': '// gui'
}

// The shape one real app has and the fixture above does not: a bundle whose mounted
// half is mostly neither its GUI nor its icon. App Code ships a compiler SDK this way
// — 236 files beside the two that put it on screen.
const HOSTED_SDK: Record<string, string> = {
	...HOSTED,
	'sdk/one.d.ts': '// types',
	'sdk/two.d.ts': '// more types',
	'sdk/runtime.js': '// sdk runtime'
}

describe('prefetch', () => {
	test('a hosted app reads offline once installed', async () => {
		const store = await builtinStore(HOSTED)
		const { kernel, requested } = fakeWorld((path) => enc.encode(HOSTED[path] ?? ''))
		await materialise(kernel, store)

		// Fetched during the install, not on first read: "installed" has to mean the
		// app works without a network, and the reducer alone is the half you cannot see.
		expect(requested).toEqual(['gui.js'])

		const offline = fakeWorld() // serves nothing
		const installed = await kernel.app('app.x')
		expect(new TextDecoder().decode(await installed.read('gui.js'))).toBe('// gui')
		expect(requested).toEqual(['gui.js']) // still one — the second read hit the cache
		expect(offline.requested).toEqual([])
	})

	test('an unreachable origin leaves the app installed with a cold cache', async () => {
		const store = await builtinStore(HOSTED)
		const { kernel, installs, requested } = fakeWorld() // offline from the start

		await materialise(kernel, store)

		// The install stands: the record and the reducer are in the volume, and the
		// GUI mounts on demand later exactly as it did before.
		expect(installs).toEqual(['app.x'])
		expect(requested).toEqual(['gui.js'])
	})

	test('a local app has nothing to prefetch', async () => {
		const store = await builtinStore(HOSTED, null)
		const { kernel, installs, requested } = fakeWorld()
		await materialise(kernel, store)
		expect(installs).toEqual(['app.x'])
		expect(requested).toEqual([])
	})

	test('the named entries are warmed; the rest of the bundle waits to be asked for', async () => {
		const store = await builtinStore(HOSTED_SDK)
		const { kernel, requested } = fakeWorld((path) => enc.encode(HOSTED_SDK[path] ?? ''))

		await materialise(kernel, store)

		// "Every mounted file" is not a bounded set: one app's SDK is 236 of them, against
		// a runner cache of 500 entries, and this pass runs again on every catalog change
		// and every burst of sync traffic. What the manifest NAMES is what a host needs to
		// show the app and open it.
		expect(requested).toEqual(['gui.js'])

		// And the rest is not lost — it is pinned in the record and mounts when something
		// reads it, verified on the way in like every other mounted byte.
		const installed = await kernel.app('app.x')
		expect(new TextDecoder().decode(await installed.read('sdk/runtime.js'))).toBe('// sdk runtime')
		expect(requested).toEqual(['gui.js', 'sdk/runtime.js'])
	})

	test('a prefetch that cannot even resolve the app does not fail the install', async () => {
		// The install has committed by the time the prefetch starts, so a transient
		// failure reading the record back out is not a failed install: the caller would
		// report one for a working app, and materialise would stop before the built-ins
		// after it. Only the per-file reads were swallowed before.
		const { kernel, installs } = fakeWorld((path) => enc.encode(HOSTED[path] ?? ''))
		const app = kernel.app
		kernel.app = async () => {
			kernel.app = app // one transient failure, on the prefetch that follows the install
			throw new Error('storage is having a moment')
		}

		await expect(materialise(kernel, await builtinStore(HOSTED))).resolves.toBeUndefined()
		expect(installs).toEqual(['app.x'])
	})
})

describe('prefetch on the sync path', () => {
	test('an app that arrived through sync is warmed by reconcile, once', async () => {
		const store = await builtinStore(HOSTED)
		const source = fakeWorld((path) => enc.encode(HOSTED[path] ?? ''))
		await materialise(source.kernel, store)

		// The receiving device. Sync replicates the durable half — the record and the
		// reducer — but not the host cache, so the receiving browser starts cold and no
		// install ever ran here to fill it.
		const device = fakeWorld((path) => enc.encode(HOSTED[path] ?? ''))
		for (const [path, bytes] of source.blobs) device.blobs.set(path, bytes)

		await reconcile(device.kernel, device.fs, store)
		expect(device.requested).toEqual(['gui.js'])
		expect(device.installs).toEqual([]) // `decide` said skip; this is not a reinstall

		// And not paid for again on every later pass — the watcher runs reconcile on
		// each burst of sync traffic, so a warm app has to cost one cached read and no
		// payload.
		await reconcile(device.kernel, device.fs, store)
		expect(device.requested).toEqual(['gui.js'])
	})

	test('an app that arrived through sync gets its entries and not its SDK', async () => {
		const store = await builtinStore(HOSTED_SDK)
		const source = fakeWorld((path) => enc.encode(HOSTED_SDK[path] ?? ''))
		await materialise(source.kernel, store)
		const device = fakeWorld((path) => enc.encode(HOSTED_SDK[path] ?? ''))
		for (const [path, bytes] of source.blobs) device.blobs.set(path, bytes)

		await reconcile(device.kernel, device.fs, store)

		expect(device.requested).toEqual(['gui.js'])
		expect(device.installs).toEqual([])
	})

	test('a cache the previous release left behind counts as cold, not warm', async () => {
		const v1: Record<string, string> = { ...HOSTED, 'gui.js': '// gui v1' }
		const v2: Record<string, string> = {
			'manifest.json': JSON.stringify({
				id: 'app.x',
				name: 'X',
				version: '2.0.0',
				app: 'app.js',
				gui: 'gui.js'
			}),
			'app.js': '// code',
			'gui.js': '// gui v2'
		}

		// This device ran v1, so its cache holds v1's bytes at the very path v2 mounts.
		let serving = v1
		const device = fakeWorld((path) => enc.encode(serving[path] ?? ''))
		await materialise(device.kernel, await builtinStore(v1))
		expect(device.requested).toEqual(['gui.js'])
		serving = v2

		// Then v2 arrives through sync — the record and reducer replicate. Its immutable
		// base URL differs, so the host cache cannot return v1 under the v2 request.
		const source = fakeWorld((path) => enc.encode(v2[path] ?? ''))
		const store = await builtinStore(v2)
		await materialise(source.kernel, store)
		for (const [path, bytes] of source.blobs) device.blobs.set(path, bytes)
		device.requested.length = 0
		device.installs.length = 0 // only count what the reconcile below does

		// Presence alone would call that warm and fetch nothing, leaving a device that
		// looks stocked and cannot open its own GUI the moment it goes offline.
		await reconcile(device.kernel, device.fs, store)
		expect(device.requested).toEqual(['gui.js'])
		expect(device.installs).toEqual([]) // still a skip, not a reinstall

		const offline = fakeWorld() // serves nothing
		const installed = await device.kernel.app('app.x')
		expect(new TextDecoder().decode(await installed.read('gui.js'))).toBe('// gui v2')
		expect(offline.requested).toEqual([])
	})
})
