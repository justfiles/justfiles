import { describe, expect, test } from 'vitest'
import { COMMUNITY_CATALOG_SCHEMA, type CommunityCatalog } from '../../shared/appstore.ts'
import {
	buildCatalog,
	type Denylist,
	distFiles,
	type IndexInput,
	type JsDelivrNode
} from './indexer.ts'

const FILES = [
	{ path: 'manifest.json', hash: 'sha256-aa', size: 10 },
	{ path: 'app.js', hash: 'sha256-bb', size: 20 }
]

function manifest(id: string, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ id, name: 'X', app: 'app.js', ...extra })
}

function input(npm: string, id: string, over: Partial<IndexInput> = {}): IndexInput {
	return {
		npm,
		version: '1.0.0',
		publisher: 'npm:u',
		manifest: manifest(id),
		files: FILES,
		...over
	}
}

const EMPTY: CommunityCatalog = { schema: COMMUNITY_CATALOG_SCHEMA, apps: [] }
const NO_DENY: Denylist = { names: [], ids: [] }

describe('buildCatalog', () => {
	test('indexes a first-party canary and a third-party app', () => {
		const { catalog, flags } = buildCatalog(
			[
				input('@justfiles/app-code', 'app.justfiles.frieren.code', {
					manifest: manifest('app.justfiles.frieren.code', { name: 'Code', icon: 'icon.png' }),
					repository: 'https://github.com/x/code',
					description: 'Build apps'
				}),
				input('example-notes', 'com.example.notes')
			],
			EMPTY,
			NO_DENY
		)
		expect(flags).toEqual([])
		expect(catalog.schema).toBe(COMMUNITY_CATALOG_SCHEMA)
		const code = catalog.apps.find((a) => a.id === 'app.justfiles.frieren.code')
		expect(code).toMatchObject({
			npm: '@justfiles/app-code',
			name: 'Code',
			icon: 'icon.png',
			version: '1.0.0',
			publisher: 'npm:u',
			repository: 'https://github.com/x/code'
		})
		expect(code?.files).toEqual(FILES)
		expect(catalog.apps.map((a) => a.id)).toContain('com.example.notes')
	})

	test('skips a reserved-prefix id from a foreign scope, and flags it', () => {
		const { catalog, flags } = buildCatalog(
			[input('evil-pkg', 'computer.spud.evil')],
			EMPTY,
			NO_DENY
		)
		expect(catalog.apps).toEqual([])
		expect(flags).toHaveLength(1)
		expect(flags[0]).toMatchObject({
			npm: 'evil-pkg',
			reason: expect.stringContaining('reserved-prefix')
		})
	})

	test('skips a malformed or missing manifest', () => {
		const { catalog, flags } = buildCatalog(
			[input('a', 'x', { manifest: '{ not json' }), input('b', 'y', { manifest: null })],
			EMPTY,
			NO_DENY
		)
		expect(catalog.apps).toEqual([])
		expect(flags.map((f) => f.reason)).toEqual([
			expect.stringContaining('malformed'),
			expect.stringContaining('malformed')
		])
	})

	test('skips a non-reverse-DNS id', () => {
		const { catalog, flags } = buildCatalog([input('a', 'notdotted')], EMPTY, NO_DENY)
		expect(catalog.apps).toEqual([])
		expect(flags[0].reason).toContain('not reverse-DNS')
	})

	test('skips an app missing its manifest.json or app entry in dist', () => {
		const { catalog, flags } = buildCatalog(
			[input('a', 'com.a.b', { files: [{ path: 'manifest.json', hash: 'sha256-aa', size: 1 }] })],
			EMPTY,
			NO_DENY
		)
		expect(catalog.apps).toEqual([])
		expect(flags[0].reason).toContain('app entry')
	})

	test('id conflict: first package to claim an id wins, the second is flagged', () => {
		const { catalog, flags } = buildCatalog(
			[input('pkg-a', 'com.example.notes'), input('pkg-b', 'com.example.notes')],
			EMPTY,
			NO_DENY
		)
		expect(catalog.apps).toHaveLength(1)
		expect(catalog.apps[0].npm).toBe('pkg-a')
		expect(flags[0]).toMatchObject({
			npm: 'pkg-b',
			reason: expect.stringContaining('already bound')
		})
	})

	test('a package that changes its own id in a later version is skipped', () => {
		const previous: CommunityCatalog = {
			schema: COMMUNITY_CATALOG_SCHEMA,
			apps: [
				{
					id: 'com.a.one',
					name: 'One',
					version: '1.0.0',
					npm: 'pkg-a',
					publisher: 'npm:u',
					files: FILES
				}
			]
		}
		const { catalog, flags } = buildCatalog([input('pkg-a', 'com.a.two')], previous, NO_DENY)
		expect(catalog.apps).toHaveLength(1)
		expect(catalog.apps[0].id).toBe('com.a.one') // unchanged binding retained
		expect(flags[0].reason).toContain('changed its id')
	})

	test('denylisted package/id are dropped (quietly, and even if already indexed)', () => {
		const previous: CommunityCatalog = {
			schema: COMMUNITY_CATALOG_SCHEMA,
			apps: [
				{
					id: 'com.old.gone',
					name: 'Old',
					version: '1.0.0',
					npm: 'gone-pkg',
					publisher: 'npm:u',
					files: FILES
				}
			]
		}
		const { catalog, flags } = buildCatalog(
			[input('bad-pkg', 'com.x.y'), input('c', 'com.banned.id')],
			previous,
			{ names: ['bad-pkg', 'gone-pkg'], ids: ['com.banned.id'] }
		)
		expect(catalog.apps).toEqual([])
		expect(flags).toEqual([])
	})

	test('retains previously-indexed apps a run does not re-surface', () => {
		const previous: CommunityCatalog = {
			schema: COMMUNITY_CATALOG_SCHEMA,
			apps: [
				{
					id: 'com.keep.me',
					name: 'Keep',
					version: '2.0.0',
					npm: 'keep-pkg',
					publisher: 'npm:u',
					files: FILES
				}
			]
		}
		const { catalog } = buildCatalog([], previous, NO_DENY)
		expect(catalog.apps.map((a) => a.npm)).toEqual(['keep-pkg'])
	})
})

describe('distFiles', () => {
	test('flattens the dist subtree and converts base64 hashes to sha256-hex', () => {
		const hex = 'abcdef0123456789'
		const b64 = Buffer.from(hex, 'hex').toString('base64')
		const tree: JsDelivrNode[] = [
			{ type: 'file', name: 'package.json', hash: b64, size: 5 }, // outside dist → ignored
			{
				type: 'directory',
				name: 'dist',
				files: [
					{ type: 'file', name: 'manifest.json', hash: b64, size: 10 },
					{ type: 'file', name: 'app.js', hash: b64, size: 20 },
					{
						type: 'directory',
						name: 'devkit',
						files: [{ type: 'file', name: 'x.js', hash: b64, size: 3 }]
					}
				]
			}
		]
		expect(distFiles(tree)).toEqual([
			{ path: 'manifest.json', hash: `sha256-${hex}`, size: 10 },
			{ path: 'app.js', hash: `sha256-${hex}`, size: 20 },
			{ path: 'devkit/x.js', hash: `sha256-${hex}`, size: 3 }
		])
	})

	test('returns nothing when there is no dist directory', () => {
		expect(distFiles([{ type: 'file', name: 'index.js', hash: 'x', size: 1 }])).toEqual([])
	})
})
