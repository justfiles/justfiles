import { expect, test } from 'vitest'
import { rebuildStore } from './index'
import type { Catalog } from './refresh-catalog'

// The store projection is rebuilt from R2 alone. These tests are mostly about
// that "alone": no `fetch` is stubbed here, so anything reaching for the network
// fails loudly.

const objects: Record<string, unknown> = {
	'apps/alice.notes/record.json': {
		current: '1.2.0',
		releases: { '1.2.0': { state: 'ready' } }
	},
	'apps/alice.notes/1.2.0/manifest.json': {
		schema: 'justapps/manifest/v1',
		id: 'alice.notes',
		name: 'Notes',
		description: 'Writes things down',
		version: '1.2.0',
		icon: 'icon.png',
		app: 'app.js',
		hash: 'abc',
		files: []
	},
	// Its entry has landed and its first import has not, so it is listable and
	// hosts nothing. It must not appear.
	'apps/bob.draft/record.json': { current: null, releases: {} },
	// Alphabetically first, to prove the index is sorted by NAME.
	'apps/zoe.abacus/record.json': { current: '0.1.0', releases: { '0.1.0': { state: 'ready' } } },
	'apps/zoe.abacus/0.1.0/manifest.json': {
		schema: 'justapps/manifest/v1',
		id: 'zoe.abacus',
		name: 'Abacus',
		version: '0.1.0',
		app: 'app.js',
		hash: 'def',
		files: []
	}
}

const catalog = {
	schema: 2,
	sha: 'a3f9c21',
	etag: null,
	entries: {
		'alice.notes': { repo: 'alice/notes', status: 'active' },
		'bob.draft': { repo: 'bob/draft', status: 'active' }
	}
} as Catalog

/** One prefix per page, so the walk is also a test that it pages to the end. */
const env = (): CloudflareBindings => {
	const state = { ...objects }
	return {
		ROOT_DOMAIN: 'example.com',
		STORE: {
			get: async (key: string) => (key in state ? { json: async () => state[key] } : null),
			put: async (key: string, value: string) => {
				state[key] = JSON.parse(value)
			},
			list: async ({ cursor }: { cursor?: string } = {}) => {
				const prefixes = [
					...new Set(
						Object.keys(state)
							.filter((key) => key.startsWith('apps/'))
							.map((key) => `${key.split('/').slice(0, 2).join('/')}/`)
					)
				]
				const at = cursor ? Number(cursor) : 0
				return {
					delimitedPrefixes: prefixes.slice(at, at + 1),
					truncated: at + 1 < prefixes.length,
					cursor: String(at + 1)
				}
			}
		}
	} as unknown as CloudflareBindings
}

test('the projection lists what is actually reachable, by name', async () => {
	const index = await rebuildStore(env(), catalog)
	expect(index.schema).toBe('justapps/store/v1')
	expect(index.apps.map((app) => app.id)).toEqual(['zoe.abacus', 'alice.notes'])
})

test('an entry points at the mutable manifest and a version-pinned icon', async () => {
	const { apps } = await rebuildStore(env(), catalog)
	expect(apps.find((app) => app.id === 'alice.notes')).toEqual({
		id: 'alice.notes',
		name: 'Notes',
		description: 'Writes things down',
		version: '1.2.0',
		iconUrl: 'https://alice-notes.example.com/v/1.2.0/icon.png',
		manifestUrl: 'https://alice-notes.example.com/manifest.json',
		repository: 'https://github.com/alice/notes'
	})
	// An app the catalog no longer lists still serves; the projection just has no
	// repository to name.
	expect(apps.find((app) => app.id === 'zoe.abacus')?.repository).toBeUndefined()
})

test('it is written where the root site reads it', async () => {
	const bindings = env()
	const index = await rebuildStore(bindings, catalog)
	expect(await (await bindings.STORE.get('store.json'))?.json()).toEqual(index)
})
