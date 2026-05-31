import type { AppBundle, AppManifest, Kernel } from '@justfiles/app'
import type { Volume } from '@justfiles/fs'
import { describe, expect, test } from 'vitest'
import { CATALOG_SCHEMA, type Catalog, reconcileBuiltins } from './appstore'

const catalog: Catalog = {
	schema: CATALOG_SCHEMA,
	apps: [
		{
			id: 'app.x',
			name: 'X',
			version: '1.0.0',
			icon: 'icon.svg',
			files: [
				{ path: 'manifest.json', hash: 'h', size: 0 },
				{ path: 'app.js', hash: 'h', size: 0 }
			]
		}
	]
}

const read = async (app: { id: string; version: string }, path: string): Promise<Uint8Array> =>
	new TextEncoder().encode(
		path === 'manifest.json'
			? JSON.stringify({ id: app.id, name: 'X', version: app.version, app: 'app.js' })
			: '// code'
	)

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
})
