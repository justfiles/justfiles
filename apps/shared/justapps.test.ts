import { describe, expect, test } from 'vitest'
import type { AppStore, CatalogApp } from '../../packages/app/appstore.ts'
import {
	mergeAppStores,
	RUNNER_MANIFEST_SCHEMA,
	RUNNER_STORE_SCHEMA,
	RUNNER_STORE_URL,
	type RunnerCatalogApp,
	runnerAppStore
} from './justapps.ts'

const manifestUrl = 'https://justfiles-notes.justapps.run/manifest.json'
const releaseUrl = 'https://justfiles-notes.justapps.run/v/1.2.0/manifest.json'
const paintManifestUrl = 'https://justfiles-paint.justapps.run/manifest.json'
const paintReleaseUrl = 'https://justfiles-paint.justapps.run/v/0.1.0/manifest.json'
const taskManifestUrl = 'https://com-example-tasks.justapps.run/manifest.json'
const release = {
	schema: RUNNER_MANIFEST_SCHEMA,
	id: 'justfiles.notes',
	name: 'Notes',
	description: 'Write things down',
	version: '1.2.0',
	icon: 'icon.svg',
	app: 'app.js',
	gui: 'gui.js',
	capabilities: {},
	hash: 'release-hash',
	files: [
		{ path: 'app.js', hash: 'sha256-a', size: 1 },
		{ path: 'gui.js', hash: 'sha256-b', size: 1 }
	]
}
const paintRelease = {
	...release,
	id: 'justfiles.paint',
	name: 'Paint',
	description: 'Pixel drawing',
	version: '0.1.0',
	icon: 'icon.png',
	hash: 'paint-release-hash'
}
const runner = {
	schema: RUNNER_STORE_SCHEMA,
	apps: [
		{
			id: release.id,
			name: release.name,
			version: release.version,
			iconUrl: 'https://justfiles-notes.justapps.run/v/1.2.0/icon.svg',
			manifestUrl,
			repository: 'https://example.com/notes'
		},
		{
			id: paintRelease.id,
			name: paintRelease.name,
			version: paintRelease.version,
			iconUrl: 'https://justfiles-paint.justapps.run/v/0.1.0/icon.png',
			manifestUrl: paintManifestUrl,
			repository: 'https://github.com/justfiles/app-paint'
		},
		{
			id: 'com.example.tasks',
			name: 'Tasks',
			version: '1.0.0',
			manifestUrl: taskManifestUrl
		}
	]
}

function json(data: unknown, url = ''): Response {
	const response = new Response(JSON.stringify(data))
	Object.defineProperty(response, 'url', { value: url })
	return response
}

describe('runnerAppStore', () => {
	test('an unavailable registry does not provide a store', async () => {
		const store = await runnerAppStore(async () => {
			throw new Error('offline')
		})

		expect(store).toBeNull()
	})

	test('an invalid registry response does not provide a store', async () => {
		const store = await runnerAppStore(async () => new Response('{'))

		expect(store).toBeNull()
	})

	test('an unknown registry schema does not provide a store', async () => {
		const store = await runnerAppStore(async () => json({ schema: 'old', apps: [] }))

		expect(store).toBeNull()
	})

	test('follows the manifest pointer and reads from its final immutable release URL', async () => {
		const seen: string[] = []
		const request = async (url: string): Promise<Response> => {
			seen.push(url)
			if (url === RUNNER_STORE_URL) return json(runner, RUNNER_STORE_URL)
			if (url === manifestUrl) return json(release, releaseUrl)
			if (url.endsWith('/app.js')) return new Response(new Uint8Array([1, 2, 3]))
			return new Response(null, { status: 404 })
		}

		const store = await runnerAppStore(request)
		expect(seen).toEqual([RUNNER_STORE_URL])
		const app = await store?.latest(release.id)
		expect(app).toMatchObject({
			id: release.id,
			version: '1.2.0',
			baseUrl: 'https://justfiles-notes.justapps.run/v/1.2.0/',
			hash: 'release-hash',
			manifest: { app: 'app.js', gui: 'gui.js' }
		})
		await store?.latest(release.id)
		expect(seen.filter((url) => url === manifestUrl)).toHaveLength(1)
		expect([...(await store!.read(app!, 'app.js'))]).toEqual([1, 2, 3])
		expect(seen.at(-1)).toBe('https://justfiles-notes.justapps.run/v/1.2.0/app.js')
	})

	test('trusts only host-allowlisted Runner apps as built-ins', async () => {
		const seen: string[] = []
		const store = await runnerAppStore(async (url) => {
			seen.push(url)
			if (url === RUNNER_STORE_URL) return json(runner, RUNNER_STORE_URL)
			if (url === manifestUrl) return json(release, releaseUrl)
			if (url === paintManifestUrl) return json(paintRelease, paintReleaseUrl)
			return new Response(null, { status: 404 })
		})

		const apps = await store?.builtins()
		expect(apps?.map((app) => app.id)).toEqual(['justfiles.notes', 'justfiles.paint'])
		expect(apps?.at(-1)?.baseUrl).toBe('https://justfiles-paint.justapps.run/v/0.1.0/')
		expect(seen).not.toContain(taskManifestUrl)
	})

	test('omits an app whose canonical manifest cannot be loaded', async () => {
		const store = await runnerAppStore(async (url) =>
			url === RUNNER_STORE_URL
				? json(runner, RUNNER_STORE_URL)
				: new Response(null, { status: 404 })
		)
		expect(await store?.catalog()).toEqual([])
	})

	test('rejects a file response that is not successful', async () => {
		const store = await runnerAppStore(async (url) => {
			if (url === RUNNER_STORE_URL) return json(runner, RUNNER_STORE_URL)
			if (url === manifestUrl) return json(release, releaseUrl)
			return new Response(null, { status: 503 })
		})
		const app = await store?.latest(release.id)

		await expect(store!.read(app!, 'app.js')).rejects.toThrow('503')
	})
})

describe('mergeAppStores', () => {
	const primaryApp: CatalogApp = {
		id: 'justfiles.notes',
		name: 'Packaged Notes',
		version: '1.0.0',
		files: []
	}
	const hostedApp: RunnerCatalogApp = {
		id: 'justfiles.notes',
		name: 'Hosted Notes',
		version: '1.0.0',
		files: [],
		manifestUrl: 'https://notes.justapps.run/manifest.json',
		manifest: { id: 'justfiles.notes', name: 'Hosted Notes', app: 'app.js' },
		hash: 'hosted'
	}

	function stores(): { primary: AppStore; hosted: AppStore } {
		return {
			primary: {
				async builtins() {
					return [primaryApp]
				},
				async latest() {
					return primaryApp
				},
				async read() {
					return new Uint8Array([1])
				}
			},
			hosted: {
				async builtins() {
					return [hostedApp]
				},
				async latest() {
					return hostedApp
				},
				async read() {
					return new Uint8Array([2])
				}
			}
		}
	}

	test('keeps the primary store authoritative for duplicate app IDs', async () => {
		const { primary, hosted } = stores()
		const store = mergeAppStores(primary, hosted)

		expect(await store.builtins()).toEqual([primaryApp])
		expect(await store.latest(primaryApp.id)).toBe(primaryApp)
	})

	test('reads an app from the store that supplied it', async () => {
		const { primary, hosted } = stores()
		const store = mergeAppStores(primary, hosted)

		expect([...(await store.read(primaryApp, 'app.js'))]).toEqual([1])
		expect([...(await store.read(hostedApp, 'app.js'))]).toEqual([2])
	})
})
