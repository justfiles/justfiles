import type { Volume } from '@justfiles/fs'
import { describe, expect, test } from 'vitest'
import { type AppStore, type CatalogApp, materialise, reconcile, semverGte } from './appstore.ts'
import { bundleFilePath } from './kernel.app.ts'
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

async function catalogApp(id: string, files: Record<string, string>): Promise<CatalogApp> {
	const fileList = await Promise.all(
		Object.entries(files).map(async ([path, content]) => ({
			path,
			hash: `sha256-${await sha256Hex(enc.encode(content))}`,
			size: enc.encode(content).byteLength
		}))
	)
	// Mirror the store: the catalog version is the app's declared manifest version.
	const version = (JSON.parse(files['manifest.json'] ?? '{}') as { version?: string }).version
	return { id, name: id, version: version ?? '1.0.0', icon: 'icon.svg', files: fileList }
}

// A store carrying one built-in whose pinned hashes match the bytes `read`
// returns — so the integrity check passes and reconcile compares real digests.
async function builtinStore(files: Record<string, string>): Promise<AppStore> {
	const app = await catalogApp('app.x', files)
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
function fakeWorld() {
	const blobs = new Map<string, Uint8Array>() // volume path -> bytes
	const installs: string[] = []
	const kernel = {
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
			// Like the real kernel: the whole app root is REPLACED (so a file the new
			// bundle doesn't stage is gone), and each file lands in its residency lane.
			for (const path of [...blobs.keys()]) {
				if (path.match(/^(\/\.cache)?\/applications\/([^/]+)\//)?.[2] === manifest.id) {
					blobs.delete(path)
				}
			}
			for await (const path of b.list()) {
				blobs.set(bundleFilePath(manifest.id, manifest, path), await b.read(path))
			}
			blobs.set(`/applications/${manifest.id}/manifest.json`, enc.encode(JSON.stringify(manifest)))
			return manifest.id
		},
		uninstall: async (id: string): Promise<void> => {
			for (const path of [...blobs.keys()]) {
				if (path.match(/^(\/\.cache)?\/applications\/([^/]+)\//)?.[2] === id) blobs.delete(path)
			}
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
	return { kernel, fs, installs, blobs }
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
		const store = await builtinStore(FILES)
		const { kernel, installs } = fakeWorld()
		store.read = async (_app, path) =>
			enc.encode(path === 'app.js' ? '// tampered' : (FILES[path] ?? ''))
		await expect(materialise(kernel, store)).rejects.toThrow(/hash/)
		expect(installs).toEqual([])
	})
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

	test('reinstalls when a file is missing even if .apphash matches', async () => {
		const store = await builtinStore(FILES)
		const { kernel, fs, installs, blobs } = fakeWorld()
		await materialise(kernel, store) // installs, writes .apphash
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

// #376: a built-in's GUI is a CACHE of bytes the release already serves, so it stops
// syncing. The reducer keeps syncing — the DO runs it headlessly for the agent.
describe('residency', () => {
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

	test('a built-in installs its reducer synced and its gui cached', async () => {
		const { kernel, fs, blobs } = fakeWorld()
		await materialise(kernel, await builtinStore(GUI_FILES))

		expect([...blobs.keys()].sort()).toEqual([
			'/.cache/applications/app.x/gui.js',
			'/applications/app.x/.apphash',
			'/applications/app.x/app.js',
			'/applications/app.x/manifest.json'
		])
		const manifest = JSON.parse(
			new TextDecoder().decode(await fs.readFile('/applications/app.x/manifest.json'))
		)
		expect(manifest.assets).toBe('cached')
	})

	// An existing install exactly as this release finds it: every byte synced, a
	// manifest with no residency field, and a `.apphash` that MATCHES the catalog — the
	// state in which every other signal `decide` reads says "skip".
	async function preMigrationWorld() {
		const world = fakeWorld()
		const store = await builtinStore(GUI_FILES)
		await materialise(world.kernel, store)
		const { blobs } = world
		const gui = blobs.get('/.cache/applications/app.x/gui.js')
		if (!gui) throw new Error('expected a cached gui')
		blobs.set('/applications/app.x/gui.js', gui)
		blobs.delete('/.cache/applications/app.x/gui.js')
		const manifest = JSON.parse(
			new TextDecoder().decode(blobs.get('/applications/app.x/manifest.json'))
		)
		manifest.assets = undefined
		blobs.set('/applications/app.x/manifest.json', enc.encode(JSON.stringify(manifest)))
		world.installs.length = 0
		return { ...world, store }
	}

	// The migration, and the reason `filesPresentAndMatch` stats the lane CURRENT POLICY
	// dictates rather than the one the installed manifest claims. Trust the manifest here
	// and every file is present and matching under an unchanged app hash: `decide`
	// returns 'skip' and the bytes never move.
	test('a pre-#376 install repairs itself into the cache lane', async () => {
		const { kernel, fs, installs, blobs, store } = await preMigrationWorld()

		await reconcile(kernel, fs, store)

		expect(installs).toEqual(['app.x']) // repaired, with no version bump
		// The synced copy is GONE — `kernel.install` replaces the whole app root, so the
		// delete propagates and the DO's storage shrinks with no migration code.
		expect(blobs.has('/applications/app.x/gui.js')).toBe(false)
		expect(blobs.has('/.cache/applications/app.x/gui.js')).toBe(true)
		// And the reducer the DO runs stayed exactly where it was.
		expect(blobs.has('/applications/app.x/app.js')).toBe(true)
	})

	test('the migration happens once — the next pass skips', async () => {
		const { kernel, fs, installs, store } = await preMigrationWorld()
		await reconcile(kernel, fs, store)
		await reconcile(kernel, fs, store)
		expect(installs).toEqual(['app.x'])
	})

	test('an evicted cache file is repaired, not left broken', async () => {
		const { kernel, fs, installs, blobs } = fakeWorld()
		const store = await builtinStore(GUI_FILES)
		await materialise(kernel, store)
		blobs.delete('/.cache/applications/app.x/gui.js')
		await reconcile(kernel, fs, store)
		expect(installs).toEqual(['app.x', 'app.x'])
		expect(blobs.has('/.cache/applications/app.x/gui.js')).toBe(true)
	})

	// Community apps are refilled from a third-party CDN, and a locally-authored app has
	// no upstream at all. Neither moves lane yet; both keep syncing in full.
	test('a non-built-in keeps every byte in the synced lane', async () => {
		const { kernel, fs, installs, blobs } = fakeWorld()
		const files = (version: string): Record<string, string> => ({
			'manifest.json': JSON.stringify({
				id: 'app.z',
				name: 'Z',
				version,
				app: 'app.js',
				gui: 'gui.js'
			}),
			'app.js': `// reducer ${version}`,
			'gui.js': `// gui ${version}`
		})
		const next = await catalogApp('app.z', files('2.0.0'))
		const store: AppStore = {
			builtins: async () => [],
			latest: async (id) => (id === 'app.z' ? next : null),
			read: async (_app, path) => enc.encode(files('2.0.0')[path] ?? '')
		}
		await kernel.install(bundle(files('1.0.0')))
		installs.length = 0
		await reconcile(kernel, fs, store)

		expect(installs).toEqual(['app.z']) // updated via latest()
		expect(blobs.has('/applications/app.z/gui.js')).toBe(true)
		expect([...blobs.keys()].some((p) => p.startsWith('/.cache/'))).toBe(false)
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
