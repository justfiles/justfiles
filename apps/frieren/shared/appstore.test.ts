import type { AppBundle, AppManifest, Kernel } from '@justfiles/app'
import type { Volume } from '@justfiles/fs'
import { beforeAll, describe, expect, test } from 'vitest'
import { CATALOG_SCHEMA, type Catalog, reconcileBuiltins } from './appstore'

const enc = new TextEncoder()

// Fixed file bytes for app.x@1.0.0 — `read` serves these and the catalog pins
// their real sha256 so reconcile's integrity check passes.
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

// Built in beforeAll so the pinned hashes match the bytes `read` returns.
let catalog: Catalog
beforeAll(async () => {
	catalog = {
		schema: CATALOG_SCHEMA,
		apps: [
			{
				id: 'app.x',
				name: 'X',
				version: '1.0.0',
				icon: 'icon.svg',
				files: [
					{
						path: 'manifest.json',
						hash: `sha256-${await sha256Hex(enc.encode(FILES['manifest.json']))}`,
						size: 0
					},
					{
						path: 'app.js',
						hash: `sha256-${await sha256Hex(enc.encode(FILES['app.js']))}`,
						size: 0
					}
				]
			}
		]
	}
})

const read = async (_app: { id: string; version: string }, path: string): Promise<Uint8Array> =>
	enc.encode(FILES[path] ?? '')

function fakeKernel(installed: { id: string; version: string }[]) {
	const installs: string[] = []
	const kernel = {
		list: async (): Promise<AppManifest[]> =>
			installed.map((m) => ({ id: m.id, name: m.id, version: m.version, app: 'app.js' })),
		install: async (bundle: AppBundle) => {
			installs.push((await bundle.manifest()).version ?? '')
			return 'app.x'
		}
	} as unknown as Kernel
	return { kernel, installs }
}

const fakeVolume = (disabled = false): Volume =>
	({ exists: async (path: string) => disabled && path.includes('/disabled/') }) as unknown as Volume

describe('reconcileBuiltins', () => {
	test('seeds a missing app', async () => {
		const { kernel, installs } = fakeKernel([])
		await reconcileBuiltins(kernel, fakeVolume(), catalog, read)
		expect(installs).toEqual(['1.0.0'])
	})

	test('skips an app already at the catalog version', async () => {
		const { kernel, installs } = fakeKernel([{ id: 'app.x', version: '1.0.0' }])
		await reconcileBuiltins(kernel, fakeVolume(), catalog, read)
		expect(installs).toEqual([])
	})

	test('overwrites an app at a different version', async () => {
		const { kernel, installs } = fakeKernel([{ id: 'app.x', version: '0.9.0' }])
		await reconcileBuiltins(kernel, fakeVolume(), catalog, read)
		expect(installs).toEqual(['1.0.0'])
	})

	test('does not resurrect a disabled app', async () => {
		const { kernel, installs } = fakeKernel([])
		await reconcileBuiltins(kernel, fakeVolume(true), catalog, read)
		expect(installs).toEqual([])
	})

	test('force overwrites even at the same version', async () => {
		const { kernel, installs } = fakeKernel([{ id: 'app.x', version: '1.0.0' }])
		await reconcileBuiltins(kernel, fakeVolume(), catalog, read, true)
		expect(installs).toEqual(['1.0.0'])
	})

	test('rejects bytes that do not match the pinned hash, before installing', async () => {
		const { kernel, installs } = fakeKernel([])
		const tampered = async (_app: { id: string; version: string }, path: string) =>
			enc.encode(path === 'app.js' ? '// tampered' : (FILES[path] ?? ''))
		await expect(reconcileBuiltins(kernel, fakeVolume(), catalog, tampered)).rejects.toThrow(/hash/)
		expect(installs).toEqual([])
	})
})
