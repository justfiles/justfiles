import { afterEach, expect, test, vi } from 'vitest'
import { seed } from './seed'

afterEach(() => vi.unstubAllGlobals())

test('copies production apps into the empty local store once', async () => {
	const production = {
		schema: 'justapps/store/v1',
		apps: [
			{
				id: 'alice.notes',
				name: 'Notes',
				version: '1.2.0',
				manifestUrl: 'https://alice-notes.justapps.run/manifest.json'
			}
		]
	}
	const manifest = {
		schema: 'justapps/manifest/v1',
		id: 'alice.notes',
		name: 'Notes',
		version: '1.2.0',
		app: 'app.js',
		hash: 'abc',
		files: [{ path: 'app.js', hash: 'sha256-abc', size: 7 }]
	}
	const fetch = vi.fn(async (input: string | URL | Request) => {
		const url = String(input)
		if (url === 'https://justapps.run/store.json') return Response.json(production)
		if (url === production.apps[0]?.manifestUrl) return Response.json(manifest)
		if (url === 'https://alice-notes.justapps.run/v/1.2.0/app.js') return new Response('the app')
		return new Response(null, { status: 404 })
	})
	vi.stubGlobal('fetch', fetch)

	const objects = new Map<string, string>()
	const puts: string[] = []
	const store = {
		get: async (key: string) => {
			const value = objects.get(key)
			return value === undefined ? null : { json: async <T>() => JSON.parse(value) as T }
		},
		put: async (key: string, value: string | ReadableStream) => {
			objects.set(key, typeof value === 'string' ? value : await new Response(value).text())
			puts.push(key)
		}
	}

	await seed(store)
	expect(objects.get('apps/alice.notes/1.2.0/files/app.js')).toBe('the app')
	expect(JSON.parse(objects.get('apps/alice.notes/record.json') ?? '')).toEqual({
		current: '1.2.0',
		releases: { '1.2.0': { state: 'ready' } }
	})
	expect(puts.at(-1)).toBe('store.json')

	await seed(store)
	expect(fetch).toHaveBeenCalledTimes(3)
})
