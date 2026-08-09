import { describe, expect, test } from 'vitest'
import {
	bootAppStore,
	CATALOG_PATH,
	CATALOG_SCHEMA,
	RUNNER_MANIFEST_SCHEMA,
	RUNNER_STORE_SCHEMA,
	RUNNER_STORE_URL,
	runnerAppStore
} from './appstore.ts'

const manifestUrl = 'https://com.example.notes.justapps.run/manifest.json'
const releaseUrl = 'https://com.example.notes.justapps.run/v/1.2.0/manifest.json'
const release = {
	schema: RUNNER_MANIFEST_SCHEMA,
	id: 'com.example.notes',
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
const runner = {
	schema: RUNNER_STORE_SCHEMA,
	apps: [
		{
			id: release.id,
			name: release.name,
			version: release.version,
			iconUrl: 'https://com.example.notes.justapps.run/v/1.2.0/icon.svg',
			manifestUrl,
			repository: 'https://example.com/notes'
		}
	]
}
const builtin = {
	schema: CATALOG_SCHEMA,
	apps: [
		{
			id: 'app.justfiles.frieren.files',
			name: 'Files',
			version: '0.1.0',
			files: [{ path: 'app.js', hash: 'sha256-b', size: 1 }]
		}
	]
}

function json(data: unknown, url = ''): Response {
	const response = new Response(JSON.stringify(data))
	Object.defineProperty(response, 'url', { value: url })
	return response
}

describe('runnerAppStore', () => {
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
			baseUrl: 'https://com.example.notes.justapps.run/v/1.2.0/',
			hash: 'release-hash',
			manifest: { app: 'app.js', gui: 'gui.js' }
		})
		expect(await store?.builtins()).toEqual([])
		await store?.latest(release.id)
		expect(seen.filter((url) => url === manifestUrl)).toHaveLength(1)
		expect([...(await store!.read(app!, 'app.js'))]).toEqual([1, 2, 3])
		expect(seen.at(-1)).toBe('https://com.example.notes.justapps.run/v/1.2.0/app.js')
	})

	test('omits an app whose canonical manifest cannot be loaded', async () => {
		const store = await runnerAppStore(async (url) =>
			url === RUNNER_STORE_URL
				? json(runner, RUNNER_STORE_URL)
				: new Response(null, { status: 404 })
		)
		expect(await store?.catalog()).toEqual([])
	})
})

describe('bootAppStore', () => {
	test('merges built-ins with Runner; built-ins remain authoritative', async () => {
		const request = async (url: string): Promise<Response> => {
			if (url === CATALOG_PATH) return json(builtin)
			if (url === RUNNER_STORE_URL) return json(runner, RUNNER_STORE_URL)
			if (url === manifestUrl) return json(release, releaseUrl)
			return new Response(null, { status: 404 })
		}
		const store = await bootAppStore(request)
		expect((await store?.builtins())?.map((app) => app.id)).toEqual(['app.justfiles.frieren.files'])
		expect((await store?.latest('app.justfiles.frieren.files'))?.version).toBe('0.1.0')
		expect((await store?.latest(release.id))?.version).toBe('1.2.0')
	})
})
