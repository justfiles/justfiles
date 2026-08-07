import { expect, test } from 'vitest'
import worker from './index.ts'

/**
 * A store over a flat key→JSON map. `list` derives the app prefixes from the
 * keys the way R2's delimiter does — every key is `apps/<id>/…` here.
 */
const store = (objects: Record<string, unknown>) => ({
	get: async (key: string) => (key in objects ? { json: async () => objects[key] } : null),
	list: async () => ({
		delimitedPrefixes: [
			...new Set(Object.keys(objects).map((key) => `${key.split('/').slice(0, 2).join('/')}/`))
		]
	})
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

const published = {
	'apps/alice.notes/info.json': { current: '1.2.0' },
	'apps/alice.notes/1.2.0/spec.json': { name: 'Notes', icon: 'icon.png' },
	// imported but never approved: bytes in the store, no `current` to serve
	'apps/bob.draft/info.json': { current: null },
	'apps/bob.draft/0.1.0/spec.json': { name: 'Draft' }
}

test('the index lists what is published, linking to each app origin', async () => {
	const page = await (await get('https://example.com/', envWith(published))).text()
	expect(page).toContain('<form method="post" action="/refresh">')
	expect(page).toContain('<button type="submit">Refresh</button>')
	expect(page).toContain('href="https://alice-notes.example.com/"')
	expect(page).toContain('Notes')
	// version-pinned, and served from the app's own origin
	expect(page).toContain('src="https://alice-notes.example.com/v/1.2.0/icon.png"')
	expect(page).not.toContain('Draft')
})

test('the index links to *.localhost in local dev', async () => {
	const page = await (await get('http://localhost:8787/', envWith(published))).text()
	expect(page).toContain('href="http://alice-notes.localhost:8787/"')
})
