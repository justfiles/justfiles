import type { Volume } from '@justfiles/fs'
import { describe, expect, test } from 'vitest'
import { type Catalog, reconcileBuiltins } from './builtins.ts'
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

// Build a catalog whose pinned hashes match the bytes `read` returns — so the
// integrity check passes and `assetsMatch` compares against the real digests.
async function buildCatalog(
	files: Record<string, string>
): Promise<{ catalog: Catalog; read: (app: { id: string }, path: string) => Promise<Uint8Array> }> {
	const fileList = await Promise.all(
		Object.entries(files).map(async ([path, content]) => ({
			path,
			hash: `sha256-${await sha256Hex(enc.encode(content))}`,
			size: enc.encode(content).byteLength
		}))
	)
	const catalog: Catalog = {
		schema: 'test/catalog/v1',
		apps: [{ id: 'app.x', name: 'X', version: '1.0.0', icon: 'icon.svg', files: fileList }]
	}
	const read = async (_app: { id: string }, path: string) => enc.encode(files[path] ?? '')
	return { catalog, read }
}

// One in-memory world: kernel.install writes the bundle's files into the volume
// (verbatim, like the real kernel), and volume.stat reports each file's sha256 —
// so reconcile's content comparison sees exactly what was installed.
function fakeWorld(opts: { disabled?: boolean } = {}) {
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
		install: async (bundle: AppBundle): Promise<string> => {
			const manifest = await bundle.manifest()
			installs.push(manifest.version ?? '')
			for await (const path of bundle.list()) {
				blobs.set(`/applications/${manifest.id}/${path}`, await bundle.read(path))
			}
			return manifest.id
		}
	} as unknown as Kernel
	const fs = {
		exists: async (path: string) =>
			path.includes('/disabled/') ? !!opts.disabled : blobs.has(path),
		stat: async (path: string) => {
			const bytes = blobs.get(path)
			if (!bytes) throw new Error(`ENOENT: ${path}`)
			return { contentHash: await sha256Hex(bytes) }
		}
	} as unknown as Volume
	return { kernel, fs, installs }
}

describe('reconcileBuiltins', () => {
	test('seeds a missing app', async () => {
		const { catalog, read } = await buildCatalog(FILES)
		const { kernel, fs, installs } = fakeWorld()
		await reconcileBuiltins(kernel, fs, catalog, read)
		expect(installs).toEqual(['1.0.0'])
	})

	test('skips an app whose assets already match', async () => {
		const { catalog, read } = await buildCatalog(FILES)
		const { kernel, fs, installs } = fakeWorld()
		await reconcileBuiltins(kernel, fs, catalog, read)
		await reconcileBuiltins(kernel, fs, catalog, read)
		expect(installs).toEqual(['1.0.0']) // installed once, then skipped
	})

	test('reinstalls an app whose assets changed', async () => {
		const v1 = await buildCatalog(FILES)
		const v2 = await buildCatalog({ ...FILES, 'app.js': '// code v2' })
		const { kernel, fs, installs } = fakeWorld()
		await reconcileBuiltins(kernel, fs, v1.catalog, v1.read)
		await reconcileBuiltins(kernel, fs, v2.catalog, v2.read)
		expect(installs).toEqual(['1.0.0', '1.0.0']) // changed bytes → reinstalled
	})

	test('does not resurrect a disabled app', async () => {
		const { catalog, read } = await buildCatalog(FILES)
		const { kernel, fs, installs } = fakeWorld({ disabled: true })
		await reconcileBuiltins(kernel, fs, catalog, read)
		expect(installs).toEqual([])
	})

	test('rejects bytes that do not match the pinned hash, before installing', async () => {
		const { catalog } = await buildCatalog(FILES)
		const { kernel, fs, installs } = fakeWorld()
		const tampered = async (_app: { id: string }, path: string) =>
			enc.encode(path === 'app.js' ? '// tampered' : (FILES[path] ?? ''))
		await expect(reconcileBuiltins(kernel, fs, catalog, tampered)).rejects.toThrow(/hash/)
		expect(installs).toEqual([])
	})
})
