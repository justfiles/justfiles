import { afterEach, describe, expect, test, vi } from 'vitest'
import {
	bootAppStore,
	CATALOG_PATH,
	CATALOG_SCHEMA,
	COMMUNITY_CATALOG_PATH,
	COMMUNITY_CATALOG_SCHEMA,
	communityAppStore
} from './appstore.ts'

const community = {
	schema: COMMUNITY_CATALOG_SCHEMA,
	apps: [
		{
			id: 'com.example.notes',
			name: 'Notes',
			version: '1.2.0',
			npm: 'example-notes',
			publisher: 'npm:u',
			files: [{ path: 'app.js', hash: 'sha256-x', size: 1 }]
		}
	]
}
const builtin = {
	schema: CATALOG_SCHEMA,
	apps: [
		{
			id: 'computer.spud.files',
			name: 'Files',
			version: '0.1.0',
			files: [{ path: 'app.js', hash: 'sha256-b', size: 1 }]
		}
	]
}

// A fetcher over both catalogs; unknown paths 404.
const fetcher = (path: string): Promise<Response> => {
	if (path === CATALOG_PATH) return Promise.resolve(new Response(JSON.stringify(builtin)))
	if (path === COMMUNITY_CATALOG_PATH)
		return Promise.resolve(new Response(JSON.stringify(community)))
	return Promise.resolve(new Response(null, { status: 404 }))
}

afterEach(() => vi.unstubAllGlobals())

describe('communityAppStore', () => {
	test('resolves latest and reads bytes straight from jsDelivr', async () => {
		const seen: string[] = []
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				seen.push(String(url))
				return new Response(new Uint8Array([1, 2, 3]))
			})
		)
		const store = await communityAppStore(fetcher)
		const app = await store?.latest('com.example.notes')
		expect(app?.version).toBe('1.2.0')
		const bytes = await store?.read(app!, 'app.js')
		expect([...(bytes ?? [])]).toEqual([1, 2, 3])
		expect(seen).toEqual(['https://cdn.jsdelivr.net/npm/example-notes@1.2.0/dist/app.js'])
	})

	test('ships no built-ins; unknown id resolves null', async () => {
		const store = await communityAppStore(fetcher)
		expect(await store?.builtins()).toEqual([])
		expect(await store?.latest('nope')).toBeNull()
	})
})

describe('bootAppStore', () => {
	test('merges built-ins with the community catalog; built-ins win latest', async () => {
		const store = await bootAppStore(fetcher)
		expect((await store?.builtins())?.map((a) => a.id)).toEqual(['computer.spud.files'])
		expect((await store?.latest('computer.spud.files'))?.version).toBe('0.1.0')
		expect((await store?.latest('com.example.notes'))?.version).toBe('1.2.0')
	})
})
