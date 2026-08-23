import { type GetSandbox, kernel } from '@justfiles/app'
import type { Catalog } from '@justfiles/app/appstore'
import { type Volume, volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { zipSync } from 'fflate'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
	RUNNER_MANIFEST_SCHEMA,
	RUNNER_STORE_SCHEMA,
	RUNNER_STORE_URL
} from '../../../shared/justapps.ts'
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

function json(data: unknown, url = ''): Response {
	const response = Response.json(data)
	Object.defineProperty(response, 'url', { value: url })
	return response
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

function stubRunnerBuiltin(appId: string): void {
	const manifestUrl = `https://${appId.replace('.', '-')}.justapps.run/manifest.json`
	const catalog: Catalog = { schema: CATALOG_SCHEMA, apps: [] }
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string) => {
			if (url === CATALOG_PATH) return json(catalog)
			if (url === RUNNER_STORE_URL)
				return json(
					{
						schema: RUNNER_STORE_SCHEMA,
						apps: [{ id: appId, name: 'Builtin', version: '1.0.0', manifestUrl }]
					},
					RUNNER_STORE_URL
				)
			if (url === manifestUrl)
				return json(
					{ schema: RUNNER_MANIFEST_SCHEMA, id: appId, name: 'Builtin', files: [] },
					manifestUrl.replace('manifest.json', 'v/1.0.0/manifest.json')
				)
			return new Response(null, { status: 404 })
		})
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
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(null, { status: 404 }))
		)

		await uninstallLocalApp(k, id)

		expect(await fs.exists('/applications/com.example.local')).toBe(false)
		expect(await fs.exists('/state/com.example.local.json')).toBe(false)
		expect(await fs.exists('/data/com.example.local')).toBe(false)
	})

	test('refuses to uninstall built-ins (reconcile reinstalls them on launch)', async () => {
		const { fs, k } = setup()
		const id = await installZipApp(k, appZip('justfiles.paint'))
		await seedState(fs, id)
		stubCatalog(id)

		await expect(uninstallLocalApp(k, id)).rejects.toThrow(/cannot be uninstalled/)

		expect(await fs.exists('/applications/justfiles.paint')).toBe(true)
		expect(await fs.exists('/state/justfiles.paint.json')).toBe(true)
		expect(await fs.exists('/data/justfiles.paint')).toBe(true)
	})

	test('refuses to uninstall JustApps built-ins', async () => {
		const { fs, k } = setup()
		const id = await installZipApp(k, appZip('justfiles.dictionary'))
		await seedState(fs, id)
		stubRunnerBuiltin(id)

		await expect(uninstallLocalApp(k, id)).rejects.toThrow(/cannot be uninstalled/)

		expect(await fs.exists('/applications/justfiles.dictionary')).toBe(true)
		expect(await fs.exists('/state/justfiles.dictionary.json')).toBe(true)
		expect(await fs.exists('/data/justfiles.dictionary')).toBe(true)
	})
})
