import type { Volume } from '@justfiles/fs'
import { describe, expect, test } from 'vitest'
import { type AppStore, type CatalogApp, materialise, reconcile, semverGte } from './appstore.ts'
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
			// Like the real kernel: the whole app root is REPLACED, so a file the new
			// bundle does not stage is gone — which is what makes the migration off the
			// copied layout free. A hosted bundle stages nothing but its record.
			for (const path of [...blobs.keys()]) {
				if (path.match(/^(\/private\/cache)?\/applications\/([^/]+)\//)?.[2] === manifest.id) {
					blobs.delete(path)
				}
			}
			for await (const path of b.list()) {
				blobs.set(`/applications/${manifest.id}/${path}`, await b.read(path))
			}
			blobs.set(`/applications/${manifest.id}/manifest.json`, enc.encode(JSON.stringify(manifest)))
			return manifest.id
		},
		uninstall: async (id: string): Promise<void> => {
			for (const path of [...blobs.keys()]) {
				if (path.match(/^(\/private\/cache)?\/applications\/([^/]+)\//)?.[2] === id)
					blobs.delete(path)
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
		// The copy path verifies as it downloads. (A hosted app has nothing to verify at
		// install — its bytes are checked against the record's hashes when they mount.)
		const store = await builtinStore(FILES, null)
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

	test('reinstalls a copied app when a file is missing even if the hash matches', async () => {
		// Self-heal for bytes that live IN the volume. A hosted app needs no equivalent:
		// its payload is a cache, and a miss is refilled by the read that wants it.
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

	test('a hosted install writes the record and no payload', async () => {
		const { kernel, fs, blobs } = fakeWorld()
		await materialise(kernel, await builtinStore(GUI_FILES))

		expect([...blobs.keys()]).toEqual(['/applications/app.x/manifest.json'])
		const manifest = JSON.parse(
			new TextDecoder().decode(await fs.readFile('/applications/app.x/manifest.json'))
		)
		expect(manifest.baseUrl).toBe('/appstore/apps/app.x/1.0.0')
		// The record carries what a device needs to fetch and verify on its own: the
		// version, the whole-app hash, and every file's pinned digest.
		expect(manifest.version).toBe('1.0.0')
		expect(typeof manifest.hash).toBe('string')
		expect(Object.keys(manifest.files).sort()).toEqual(['app.js', 'gui.js'])
		expect(manifest.files['gui.js']).toMatch(/^sha256-/)
	})

	test('one request, not one per file', async () => {
		// Only manifest.json is read at install; the payload is the origin's to serve
		// later. The old path downloaded every file up front.
		const store = await builtinStore(GUI_FILES)
		const read: string[] = []
		const spy = { ...store, read: (a: CatalogApp, p: string) => (read.push(p), store.read(a, p)) }
		const { kernel } = fakeWorld()
		await materialise(kernel, spy)
		expect(read).toEqual(['manifest.json'])
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
		// `kernel.install` replaces the whole app root, so the copies are gone and that
		// delete propagates: the DO's storage shrinks with no migration code.
		expect([...blobs.keys()]).toEqual(['/applications/app.x/manifest.json'])
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
