import { expect, test } from 'vitest'
import worker from './index.ts'

/**
 * A store over a flat key→JSON map. `list` derives the app prefixes from the
 * keys the way R2's delimiter does — every key is `apps/<id>/…` here — and hands
 * back ONE per page, so every test that lists is also a test that pages.
 */
const store = (objects: Record<string, unknown>) => ({
	get: async (key: string) =>
		key in objects ? { json: async () => objects[key], body: JSON.stringify(objects[key]) } : null,
	put: async (key: string, value: string) => {
		objects[key] = JSON.parse(value)
	},
	list: async ({ cursor }: { cursor?: string } = {}) => {
		const prefixes = [
			...new Set(
				Object.keys(objects)
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
	'apps/alice.notes/record.json': {
		current: '1.2.0',
		releases: { '1.2.0': { version: '1.2.0', state: 'ready' } }
	},
	'apps/alice.notes/1.2.0/manifest.json': {
		schema: 'justapps/manifest/v1',
		id: 'alice.notes',
		name: 'Notes',
		version: '1.2.0',
		icon: 'icon.png',
		app: 'app.js',
		gui: 'gui.js',
		hash: 'abc',
		files: [{ path: 'gui.js', hash: 'sha256-abc', size: 7 }]
	},
	'apps/alice.notes/1.2.0/files/gui.js': 'the app',
	// What a crashed import leaves behind: bytes under a version no release
	// record names.
	'apps/alice.notes/9.9.9/files/gui.js': 'half an app',
	// The browse index the last refresh left behind. The root site reads this and
	// never walks the bucket per visitor.
	'store.json': {
		schema: 'justapps/store/v1',
		apps: [
			{
				id: 'alice.notes',
				name: 'Notes',
				version: '1.2.0',
				iconUrl: 'https://alice-notes.example.com/v/1.2.0/icon.png',
				manifestUrl: 'https://alice-notes.example.com/manifest.json'
			}
		]
	}
}

test('the index lists what the projection holds, linking to each app origin', async () => {
	const page = await (await get('https://example.com/', envWith(published))).text()
	expect(page).toContain('href="https://alice-notes.example.com/"')
	expect(page).toContain('Notes')
	// version-pinned, and served from the app's own origin
	expect(page).toContain('src="https://alice-notes.example.com/v/1.2.0/icon.png"')
})

// Search filters the document the page already carries, so the key it matches on
// is rendered onto each entry. It is the one thing the inline script needs from
// the server, and nothing else would notice if it went missing.
test('each entry carries the key the search box matches on', async () => {
	const page = await (await get('https://example.com/', envWith(published))).text()
	expect(page).toContain('data-key="notes alice.notes"')
})

test('the projection is public, and readable by any origin', async () => {
	const res = await get('https://example.com/store.json', envWith(published))
	expect(res.headers.get('access-control-allow-origin')).toBe('*')
	expect(await res.json()).toEqual(published['store.json'])
})

test('the index links to *.localhost in local dev', async () => {
	const page = await (await get('http://localhost:8787/', envWith(published))).text()
	expect(page).toContain('href="http://alice-notes.localhost:8787/"')
	// the stored URLs name the zone, so the icon is re-based on this host too
	expect(page).toContain('src="http://alice-notes.localhost:8787/v/1.2.0/icon.png"')
})

// The icon preview is a client-side design tool, but the apps it stands a
// candidate beside are the published ones — so it reads the same projection the
// index does, and lives on the root site with it.
test('the icon preview draws the candidate beside the store', async () => {
	const page = await (await get('https://example.com/icon-preview', envWith(published))).text()
	expect(page).toContain('src="https://alice-notes.example.com/v/1.2.0/icon.png"')
})

test('a recorded release serves its bytes, frozen for a year', async () => {
	const res = await get('https://alice-notes.example.com/v/1.2.0/gui.js', envWith(published))
	expect(res.status).toBe(200)
	expect(res.headers.get('cache-control')).toContain('immutable')
})

// How an installer finds the current release, and how it learns where the bytes
// are: the redirect's destination IS the payload base, so nothing has to be
// declared in a document.
test('the manifest pointer redirects to the current release, briefly cached', async () => {
	const res = await get('https://alice-notes.example.com/manifest.json', envWith(published))
	expect(res.status).toBe(302)
	expect(res.headers.get('location')).toBe('/v/1.2.0/manifest.json')
	expect(res.headers.get('cache-control')).toBe('public, max-age=60')
	// a redirect that fails the CORS check fails the fetch that followed it
	expect(res.headers.get('access-control-allow-origin')).toBe('*')
})

test('the release manifest is served verbatim', async () => {
	const res = await get('https://alice-notes.example.com/v/1.2.0/manifest.json', envWith(published))
	expect(res.status).toBe(200)
	expect(res.headers.get('cache-control')).toContain('immutable')
	expect(await res.json()).toEqual(published['apps/alice.notes/1.2.0/manifest.json'])
})

// Host code, one body for every app: the reducer it loads arrives as the Worker's
// `name`, so nothing here is pinned to a release — and it must not be cached
// hard, or a page would run an older protocol than the shell that loaded it.
test('the reducer isolate is host code, not a release asset', async () => {
	const res = await get('https://alice-notes.example.com/worker.js', envWith(published))
	expect(res.status).toBe(200)
	expect(res.headers.get('cache-control')).toBe('no-cache')
	expect(res.headers.get('content-security-policy')).toContain("connect-src 'self'")
	expect(await res.text()).toContain('import(self.name)')
})

// An author may ship one; it is payload like any other file, and there is no
// generated `/v/{version}/worker.js` to collide with it.
test('a release may carry its own worker.js', async () => {
	const env = envWith({
		...published,
		'apps/alice.notes/1.2.0/files/worker.js': 'the author\u2019s'
	})
	const res = await get('https://alice-notes.example.com/v/1.2.0/worker.js', env)
	expect(await res.text()).toContain('author')
})

// A desktop installs and mounts a hosted app from another origin entirely, so
// every one of these has to be readable cross-origin — including the 404, which
// without the header reaches the caller as a network error instead of a status.
test('everything under /v/ is readable by any origin', async () => {
	const env = envWith(published)
	for (const path of ['gui.js', 'manifest.json', 'nothing.js']) {
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

test('the app shell keeps a shelf back to the store above the app', async () => {
	const page = await (await get('https://alice-notes.example.com/', envWith(published))).text()
	expect(page).toContain('<meta name="viewport" content="width=device-width, initial-scale=1"/>')
	expect(page).toContain('<nav id="runner-shelf" aria-label="App navigation">')
	expect(page).toContain('src="/v/1.2.0/icon.png"')
	expect(page).toContain('<span class="runner-shelf-name">Notes</span>')
	expect(page).toContain('<span class="runner-shelf-host">example.com</span>')
	expect(page).toContain(
		'class="runner-shelf-home" href="https://example.com/" aria-label="All apps"'
	)
	expect(page.indexOf('id="runner-shelf"')).toBeLessThan(page.indexOf('id="app"'))
})

test('the app GUI handles submit events but blocks native form requests', async () => {
	const res = await get('https://alice-notes.example.com/', envWith(published))
	const page = await res.text()
	const csp = res.headers.get('content-security-policy') ?? ''
	const guest = await get('https://alice-notes.example.com/gui-frame', envWith(published))
	const guestCsp = guest.headers.get('content-security-policy') ?? ''

	expect(page).toContain('<iframe id="app-frame"')
	expect(page).toContain('sandbox="allow-scripts allow-forms"')
	expect(page).not.toContain('allow-same-origin')
	expect(page).not.toContain('rel="modulepreload"')
	expect(csp).toContain("default-src 'none'")
	expect(csp).toContain("connect-src 'self'")
	expect(csp).toContain("worker-src 'self'")
	expect(guestCsp).toContain("default-src 'none'")
	expect(guestCsp).toContain('connect-src https://alice-notes.example.com/v/')
	expect(guestCsp).toContain(
		"script-src 'unsafe-inline' 'wasm-unsafe-eval' blob: https://alice-notes.example.com/v/ https://esm.sh"
	)
	expect(guestCsp).not.toContain('https://example.com/v/')
	expect(guestCsp).toContain("form-action 'none'")
	expect(guestCsp).toContain("frame-src 'none'")
})

test('the shelf links back to localhost in local dev', async () => {
	const page = await (await get('http://alice-notes.localhost:8787/', envWith(published))).text()
	expect(page).toContain('href="http://localhost:8787/"')
})

// The bytes are there for the taking; the release record is what makes them
// reachable. Otherwise a guessed version could be answered out of a half-written
// import and cached as immutable over bytes the retry then rewrites.
test('a version no release record names is not served, bytes or not', async () => {
	const env = envWith(published)
	for (const path of ['gui.js', 'manifest.json']) {
		expect((await get(`https://alice-notes.example.com/v/9.9.9/${path}`, env)).status).toBe(404)
	}
})
