import type { Volume } from '@justfiles/fs'
import { describe, expect, test } from 'vitest'
import { type AppStore, type CatalogApp, reconcile } from './builtins.ts'
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
	return { id, name: id, version: '1.0.0', icon: 'icon.svg', files: fileList }
}

// A store carrying one built-in whose pinned hashes match the bytes `read`
// returns — so the integrity check passes and `assetsMatch` compares real digests.
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
// (verbatim, like the real kernel), and volume.stat reports each file's sha256 —
// so reconcile's content comparison sees exactly what was installed.
function fakeWorld() {
	const blobs = new Map<string, Uint8Array>() // /applications/<id>/<path> -> bytes
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
			for await (const path of b.list()) {
				blobs.set(`/applications/${manifest.id}/${path}`, await b.read(path))
			}
			return manifest.id
		}
	} as unknown as Kernel
	const fs = {
		stat: async (path: string) => {
			const bytes = blobs.get(path)
			if (!bytes) throw new Error(`ENOENT: ${path}`)
			return { contentHash: await sha256Hex(bytes) }
		}
	} as unknown as Volume
	return { kernel, fs, installs }
}

describe('reconcile', () => {
	test('seeds a missing built-in', async () => {
		const store = await builtinStore(FILES)
		const { kernel, fs, installs } = fakeWorld()
		await reconcile(kernel, fs, store)
		expect(installs).toEqual(['app.x'])
	})

	test('skips a built-in whose assets already match', async () => {
		const store = await builtinStore(FILES)
		const { kernel, fs, installs } = fakeWorld()
		await reconcile(kernel, fs, store)
		await reconcile(kernel, fs, store)
		expect(installs).toEqual(['app.x']) // installed once, then skipped
	})

	test('reinstalls a built-in whose assets changed', async () => {
		const v1 = await builtinStore(FILES)
		const v2 = await builtinStore({ ...FILES, 'app.js': '// code v2' })
		const { kernel, fs, installs } = fakeWorld()
		await reconcile(kernel, fs, v1)
		await reconcile(kernel, fs, v2)
		expect(installs).toEqual(['app.x', 'app.x']) // changed bytes → reinstalled
	})

	test('rejects bytes that do not match the pinned hash, before installing', async () => {
		const store = await builtinStore(FILES)
		const { kernel, fs, installs } = fakeWorld()
		store.read = async (_app, path) =>
			enc.encode(path === 'app.js' ? '// tampered' : (FILES[path] ?? ''))
		await expect(reconcile(kernel, fs, store)).rejects.toThrow(/hash/)
		expect(installs).toEqual([])
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
})
