import { type GetSandbox, kernel } from '@justfiles/app'
import type { Catalog } from '@justfiles/app/appstore'
import { type Volume, volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { zipSync } from 'fflate'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { CATALOG_PATH, CATALOG_SCHEMA } from '../../shared/appstore'
import { installZipApp, uninstallLocalApp } from './manage'

const enc = new TextEncoder()

const sandbox: GetSandbox = async () => ({
	run: async () => ({ result: null })
})

function setup() {
	const fs = volume(memStore())
	const k = kernel({ fs, sandbox, clock: {} })
	return { fs, k }
}

function appZip(id = 'com.example.local'): Uint8Array {
	return zipSync({
		'bundle/manifest.json': enc.encode(JSON.stringify({ id, name: 'Local', app: 'app.js' })),
		'bundle/app.js': enc.encode('export const app = {}')
	})
}

async function seedState(fs: Volume, id: string): Promise<void> {
	await fs.mkdir('/state', { recursive: true })
	await fs.writeFile(`/state/${id}.json`, enc.encode('{}'))
	await fs.mkdir(`/data/${id}`, { recursive: true })
	await fs.writeFile(`/data/${id}/note.txt`, enc.encode('keep'))
}

function stubCatalog(appId: string): void {
	const catalog: Catalog = {
		schema: CATALOG_SCHEMA,
		apps: [{ id: appId, name: 'Builtin', version: '1.0.0', files: [] }]
	}
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response(JSON.stringify(catalog)))
	)
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('local app management', () => {
	test('installs a zipped app into the local volume', async () => {
		const { fs, k } = setup()
		const id = await installZipApp(k, appZip())

		expect(id).toBe('com.example.local')
		expect((await k.list()).map((app) => app.id)).toEqual(['com.example.local'])
		expect(await fs.exists('/applications/com.example.local/app.js')).toBe(true)
	})

	test('uninstalls user apps with state and data', async () => {
		const { fs, k } = setup()
		const id = await installZipApp(k, appZip())
		await seedState(fs, id)
		const fetcher = vi.fn(async () => new Response(null, { status: 404 }))
		vi.stubGlobal('fetch', fetcher)

		await uninstallLocalApp(k, id)

		expect(fetcher).toHaveBeenCalledOnce()
		expect(fetcher).toHaveBeenCalledWith(CATALOG_PATH)
		expect(await fs.exists('/applications/com.example.local')).toBe(false)
		expect(await fs.exists('/state/com.example.local.json')).toBe(false)
		expect(await fs.exists('/data/com.example.local')).toBe(false)
	})

	test('refuses to uninstall bundled catalog apps', async () => {
		const { fs, k } = setup()
		const id = await installZipApp(k, appZip('com.example.builtin'))
		await seedState(fs, id)
		stubCatalog(id)

		await expect(uninstallLocalApp(k, id)).rejects.toThrow(/cannot be uninstalled/)

		expect(await fs.exists('/applications/com.example.builtin')).toBe(true)
		expect(await fs.exists('/state/com.example.builtin.json')).toBe(true)
		expect(await fs.exists('/data/com.example.builtin')).toBe(true)
	})

	test('refuses to uninstall hosted built-ins without fetching', async () => {
		const { fs, k } = setup()
		const id = await installZipApp(k, appZip('justfiles.dictionary'))
		await seedState(fs, id)
		const fetcher = vi.fn()
		vi.stubGlobal('fetch', fetcher)

		await expect(uninstallLocalApp(k, id)).rejects.toThrow(/cannot be uninstalled/)

		expect(fetcher).not.toHaveBeenCalled()
		expect(await fs.exists('/applications/justfiles.dictionary')).toBe(true)
		expect(await fs.exists('/state/justfiles.dictionary.json')).toBe(true)
		expect(await fs.exists('/data/justfiles.dictionary')).toBe(true)
	})
})
