import { expect, test } from 'vitest'
import worker from './index.ts'

/**
 * A store over a flat key→JSON map. `list` derives the app prefixes from the
 * keys the way R2's delimiter does — every key under `apps/` is `apps/<id>/…` —
 * and hands back ONE per page, so every test that lists is also a test that
 * pages.
 */
const store = (objects: Record<string, unknown>) => ({
	get: async (key: string) =>
		key in objects ? { json: async () => objects[key], body: JSON.stringify(objects[key]) } : null,
	list: async ({ prefix = '', cursor }: { prefix?: string; cursor?: string } = {}) => {
		const prefixes = [
			...new Set(
				Object.keys(objects)
					.filter((key) => key.startsWith(prefix))
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
})

const envWith = (objects: Record<string, unknown> = {}) =>
	({ ROOT_DOMAIN: 'example.com', STORE: store(objects) }) as unknown as CloudflareBindings

// An empty store, so nothing is hosted under any id. The token binding, which
// only the reconcile reads, never loads at all.
const empty = envWith()

const get = (url: string, env = empty) =>
	worker.fetch(new Request(url), env, {} as ExecutionContext)

// These assert the SPLIT — which host reaches the app site at all — rather than
// any particular app being hosted, which is why the empty store is enough.

test('a decodable label reaches the app site', async () => {
	// nothing is published under `alice.notes`, so the app site 404s rather than
	// falling through to the runner page
	expect((await get('https://alice-notes.example.com/')).status).toBe(404)
})

test('apex and unknown hosts have no subdomain', async () => {
	expect(await (await get('https://example.com/')).text()).toContain('<h1>Apps</h1>')
	expect(await (await get('https://runner.workers.dev/')).text()).toContain('<h1>Apps</h1>')
	// deeper labels are not covered by Universal SSL, so they are not treated as subdomains
	expect(await (await get('https://a.b.example.com/')).text()).toContain('<h1>Apps</h1>')
})

test('*.localhost works in local dev', async () => {
	expect((await get('http://alice-notes.localhost:8787/')).status).toBe(404)
})

test('the platform keeps every label an id cannot encode to', async () => {
	// every id has two segments, so every app label carries a hyphen — and a-b-c style
	// labels that are not the canonical encoding of anything are refused too
	for (const host of ['www', 'api', 'store', '_weird', 'a---b']) {
		expect(await (await get(`https://${host}.example.com/`)).text()).toContain('<h1>Apps</h1>')
	}
})

const notesFiles = [
	{ path: 'app.js', hash: 'sha256-aaa', size: 11 },
	{ path: 'gui.js', hash: 'sha256-bbb', size: 22 },
	{ path: 'icon.png', hash: 'sha256-ccc', size: 33 },
	{ path: 'manifest.json', hash: 'sha256-ddd', size: 44 }
]

const published = {
	'apps/alice.notes/info.json': {
		current: '1.2.0',
		releases: { '1.2.0': { version: '1.2.0', state: 'ready' } }
	},
	'apps/alice.notes/1.2.0/spec.json': {
		name: 'Notes',
		icon: 'icon.png',
		description: 'Notes, but yours',
		capabilities: { volume: { id: 'volume', scopes: [] } }
	},
	'apps/alice.notes/1.2.0/files.json': notesFiles,
	'apps/alice.notes/1.2.0/files/gui.js': 'the app',
	// What a crashed import leaves behind: bytes under a version no release
	// record names.
	'apps/alice.notes/9.9.9/files/gui.js': 'half an app',
	// Imported by the old approval-gated runner: ready bytes, but no live pointer.
	'apps/bob.draft/info.json': {
		approved: false,
		current: null,
		releases: { '0.1.0': { version: '0.1.0', state: 'ready' } }
	},
	'apps/bob.draft/0.1.0/spec.json': { name: 'Draft' },
	'apps/bob.draft/0.1.0/files.json': [{ path: 'app.js', hash: 'sha256-eee', size: 5 }],
	'catalog.json': {
		schema: 2,
		entries: {
			'alice.notes': { repo: 'alice/notes', status: 'active' },
			'bob.draft': { repo: 'bob/draft', status: 'active' }
		}
	}
}

const storeApps = async (env = envWith(published)) =>
	(await (await get('https://example.com/store.json', env)).json()) as {
		apps: { id: string; baseUrl: string; files: unknown[]; repo?: string }[]
	}

test('the index lists what is published, linking to each app origin', async () => {
	const page = await (await get('https://example.com/', envWith(published))).text()
	expect(page).toContain('href="https://alice-notes.example.com/"')
	expect(page).toContain('Notes')
	// version-pinned, and served from the app's own origin
	expect(page).toContain('src="https://alice-notes.example.com/v/1.2.0/icon.png"')
	expect(page).toContain('Draft')
})

test('the index links to *.localhost in local dev', async () => {
	const page = await (await get('http://localhost:8787/', envWith(published))).text()
	expect(page).toContain('href="http://alice-notes.localhost:8787/"')
})

// What a desktop installs from: enough to build the record, verify every byte,
// and show who it came from before granting anything.
test('the store feed carries an installable record per app', async () => {
	const { apps } = await storeApps()
	const notes = apps.find((app) => app.id === 'alice.notes')
	expect(notes).toMatchObject({
		id: 'alice.notes',
		name: 'Notes',
		version: '1.2.0',
		icon: 'icon.png',
		description: 'Notes, but yours',
		capabilities: { volume: { id: 'volume', scopes: [] } },
		repo: 'alice/notes',
		// Version-pinned and on the app's OWN origin, not this one.
		baseUrl: 'https://alice-notes.example.com/v/1.2.0/',
		files: notesFiles
	})
})

// `spec.json` pins only what mounts, so the reducer's digest is missing from it
// by design — and a device downloads the reducer into its volume and verifies it
// there, so a feed without it cannot install anything.
test('the feed pins the reducer, which the app spec does not', async () => {
	const { apps } = await storeApps()
	const notes = apps.find((app) => app.id === 'alice.notes')
	expect(notes?.files).toContainEqual({ path: 'app.js', hash: 'sha256-aaa', size: 11 })
})

test('the feed is readable by any origin, and only briefly cacheable', async () => {
	// Unlike everything under `/v/`, this resolves each app's LIVE version — it is
	// the one document here that changes when a release lands.
	const res = await get('https://example.com/store.json', envWith(published))
	expect(res.headers.get('access-control-allow-origin')).toBe('*')
	expect(res.headers.get('cache-control')).toBe('public, max-age=300')
})

// Removing an app stops it being offered; it does not stop it being served,
// because a device pinned to one of its versions still has to resolve it.
test('a parked entry drops out of the feed', async () => {
	const parked = {
		...published,
		'catalog.json': {
			schema: 2,
			entries: { 'alice.notes': { repo: 'alice/notes', status: 'removed' } }
		}
	}
	const { apps } = await storeApps(envWith(parked))
	expect(apps.map((app) => app.id)).not.toContain('alice.notes')
	// still served, and still on the index's terms — only the offer is withdrawn
	expect(
		(await get('https://alice-notes.example.com/v/1.2.0/gui.js', envWith(parked))).status
	).toBe(200)
})

// The snapshot is derived state that the next tick rebuilds. Emptying the store
// while every app in it is still being served would be the worse failure.
test('a missing snapshot leaves the feed alone', async () => {
	const { 'catalog.json': _, ...noSnapshot } = published
	const { apps } = await storeApps(envWith(noSnapshot))
	expect(apps.map((app) => app.id)).toContain('alice.notes')
	expect(apps[0]?.repo).toBeUndefined()
})

// A release imported before `files.json` existed cannot be installed from, so it
// is not offered as if it could be.
test('a release with no file list is not offered', async () => {
	const { 'apps/alice.notes/1.2.0/files.json': _, ...older } = published
	const { apps } = await storeApps(envWith(older))
	expect(apps.map((app) => app.id)).not.toContain('alice.notes')
})

test('a recorded release serves its bytes, frozen for a year', async () => {
	const res = await get('https://alice-notes.example.com/v/1.2.0/gui.js', envWith(published))
	expect(res.status).toBe(200)
	expect(res.headers.get('cache-control')).toContain('immutable')
})

// A desktop installs and mounts a hosted app from another origin entirely, so
// every one of these has to be readable cross-origin — including the 404, which
// without the header reaches the caller as a network error instead of a status.
test('everything under /v/ is readable by any origin', async () => {
	const env = envWith(published)
	for (const path of ['gui.js', 'worker.js', 'spec.json', 'nothing.js']) {
		const res = await get(`https://alice-notes.example.com/v/1.2.0/${path}`, env)
		expect(res.headers.get('access-control-allow-origin')).toBe('*')
	}
})

// The shell is the standalone host, not a store asset. Nothing reads it
// cross-origin, so it does not get widened along with the bytes it points at.
test('the app page itself is not cross-origin readable', async () => {
	const res = await get('https://alice-notes.example.com/manifest.webmanifest', envWith(published))
	expect(res.status).toBe(200)
	expect(res.headers.get('access-control-allow-origin')).toBe(null)
})

// The bytes are there for the taking; the release record is what makes them
// reachable. Otherwise a guessed version could be answered out of a half-written
// import and cached as immutable over bytes the retry then rewrites.
test('a version no release record names is not served, bytes or not', async () => {
	const env = envWith(published)
	for (const path of ['gui.js', 'worker.js', 'spec.json']) {
		expect((await get(`https://alice-notes.example.com/v/9.9.9/${path}`, env)).status).toBe(404)
	}
})
