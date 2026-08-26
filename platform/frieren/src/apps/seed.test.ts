import type { AppBundle, AppManifest, Kernel } from '@justfiles/app'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { RUNNER_MANIFEST_SCHEMA, RUNNER_STORE_SCHEMA } from '../../../shared/justapps.ts'
import { reconcileLocalStore } from './seed.ts'

const storeUrl = 'http://localhost:4173/store.json'
const manifestUrl = 'http://localhost:4173/manifest.json'
const appUrl = 'http://localhost:4173/app.js'
const code = new TextEncoder().encode('// local app')

afterEach(() => vi.restoreAllMocks())

describe('reconcileLocalStore', () => {
	test('does not install an app that is not installed', async () => {
		const { kernel, installs } = testKernel()
		vi.spyOn(globalThis, 'fetch').mockImplementation(localStore('com.example.app'))

		await reconcileLocalStore(kernel, storeUrl)

		expect(installs).toHaveLength(0)
	})

	test('replaces a newer installed version with the local build', async () => {
		const installed = {
			id: 'justfiles.code',
			name: 'Code',
			app: 'app.js',
			version: '9.0.0',
			hash: 'published',
			baseUrl: 'https://code.justapps.run/v/9.0.0/'
		}
		const { kernel, installs } = testKernel([installed])
		vi.spyOn(globalThis, 'fetch').mockImplementation(localStore(installed.id))

		await reconcileLocalStore(kernel, storeUrl)

		expect(installs).toHaveLength(1)
		expect(installs[0]).toMatchObject({ id: installed.id, version: '1.0.0' })
	})
})

function testKernel(installed: AppManifest[] = []): { kernel: Kernel; installs: AppManifest[] } {
	const installs: AppManifest[] = []
	const kernel = {
		list: async () => installed,
		install: async (bundle: AppBundle) => {
			const manifest = await bundle.manifest()
			installs.push(manifest)
			return manifest.id
		},
		app: async () => {
			throw new Error('no preview cache in this test')
		}
	} as unknown as Kernel
	return { kernel, installs }
}

function localStore(id: string): (url: string | URL | Request) => Promise<Response> {
	return async (input) => {
		const url = String(input)
		if (url === storeUrl) {
			return json(
				{
					schema: RUNNER_STORE_SCHEMA,
					apps: [{ id, name: id, version: '1.0.0', manifestUrl }]
				},
				storeUrl
			)
		}
		if (url === manifestUrl) {
			return json(
				{
					schema: RUNNER_MANIFEST_SCHEMA,
					id,
					name: id,
					version: '1.0.0',
					app: 'app.js',
					hash: 'local',
					files: [{ path: 'app.js', hash: `sha256-${await sha256(code)}`, size: code.byteLength }]
				},
				manifestUrl
			)
		}
		if (url === appUrl) return new Response(code)
		return new Response(null, { status: 404 })
	}
}

async function sha256(bytes: Uint8Array): Promise<string> {
	const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
	const digest = await crypto.subtle.digest('SHA-256', buffer as ArrayBuffer)
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function json(value: unknown, url: string): Response {
	const response = Response.json(value)
	Object.defineProperty(response, 'url', { value: url })
	return response
}
