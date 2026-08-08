import { beforeEach, expect, it, vi } from 'vitest'

// The service worker is the only thing standing between an installed app and a
// blank page offline, and every bug in it is invisible until someone has no
// network. So it runs here against a fake CacheStorage rather than being taken
// on trust — cheaper than a browser, and it runs in CI.

type Handler = (event: unknown) => void

interface FakeRequest {
	url: string
	method: string
	mode: string
}

const ORIGIN = 'https://justfiles-draw.justapps.run'

let handlers: Record<string, Handler[]>
let cache: Map<string, Response>
/** Set to null to be offline. */
let online: ((request: FakeRequest) => Response) | null

const request = (path: string, mode = 'cors'): FakeRequest => ({
	url: `${ORIGIN}${path}`,
	method: 'GET',
	mode
})

/** Enough of the Cache API for the four calls the worker makes. */
const fakeCaches = {
	open: async () => ({
		match: async (r: FakeRequest) => cache.get(r.url)?.clone(),
		put: async (r: FakeRequest, response: Response) => void cache.set(r.url, response),
		keys: async () => [...cache.keys()].map((url) => ({ url })),
		delete: async (r: { url: string }) => cache.delete(r.url)
	})
}

async function load() {
	handlers = {}
	cache = new Map()
	online = (r) => new Response(`body of ${new URL(r.url).pathname}`, { status: 200 })

	vi.stubGlobal('self', {
		location: new URL(ORIGIN),
		addEventListener: (type: string, handler: Handler) => {
			handlers[type] = [...(handlers[type] ?? []), handler]
		},
		skipWaiting: () => {},
		clients: { claim: async () => {} }
	})
	vi.stubGlobal('caches', fakeCaches)
	vi.stubGlobal('fetch', async (r: FakeRequest) => {
		if (!online) throw new Error('offline')
		return online(r)
	})

	vi.resetModules()
	await import('./sw.js')
}

/** Fire a fetch event and return what the worker answered, or null if it passed. */
async function get(path: string, mode?: string): Promise<Response | null> {
	const [answer] = answered({ request: request(path, mode) })
	return answer ? await answer : null
}

/** What `respondWith` was called with — an array, so nothing narrows it to null. */
function answered(event: { request: unknown }): Promise<Response>[] {
	const answers: Promise<Response>[] = []
	const full = { ...event, respondWith: (r: Promise<Response>) => void answers.push(r) }
	for (const handler of handlers.fetch ?? []) handler(full)
	return answers
}

async function message(data: unknown): Promise<void> {
	const waits: Promise<unknown>[] = []
	const event = { data, waitUntil: (p: Promise<unknown>) => void waits.push(p) }
	for (const handler of handlers.message ?? []) handler(event)
	await Promise.all(waits)
}

beforeEach(load)

it('serves frozen paths from cache without revalidating', async () => {
	expect(await (await get('/v/0.4.1/gui.js'))?.text()).toBe('body of /v/0.4.1/gui.js')

	// The origin now returns something else. An immutable URL must not notice.
	online = () => new Response('TAMPERED', { status: 200 })
	expect(await (await get('/v/0.4.1/gui.js'))?.text()).toBe('body of /v/0.4.1/gui.js')
})

it('serves the app offline once it has been seen', async () => {
	await get('/', 'navigate')
	await get('/v/0.4.1/gui.js')
	await get('/assets/main-abc123.js')

	online = null
	expect(await (await get('/', 'navigate'))?.text()).toBe('body of /')
	expect(await (await get('/v/0.4.1/gui.js'))?.text()).toBe('body of /v/0.4.1/gui.js')
	expect(await (await get('/assets/main-abc123.js'))?.text()).toBe('body of /assets/main-abc123.js')
})

it('prefers the network for the document, so a publish is seen at once', async () => {
	await get('/', 'navigate')
	online = () => new Response('a newer release', { status: 200 })
	expect(await (await get('/', 'navigate'))?.text()).toBe('a newer release')
})

// `/worker.js` is host code that moves with our deployments, not with a release.
// Cached hard, a page would run an older host↔isolate protocol than the shell
// that loaded it — and offline is the one case where a stale one still beats
// nothing.
it('keeps the reducer isolate aligned with the shell, and cached only offline', async () => {
	await get('/worker.js')
	online = () => new Response('a newer protocol', { status: 200 })
	expect(await (await get('/worker.js'))?.text()).toBe('a newer protocol')

	online = null
	expect(await (await get('/worker.js'))?.text()).toBe('a newer protocol')
})

it('fails rather than inventing a response for something never cached', async () => {
	online = null
	await expect(get('/', 'navigate')).rejects.toThrow('offline')
})

it('drops other releases when the page names the one to keep', async () => {
	await get('/v/0.4.1/gui.js')
	await get('/v/0.5.0/gui.js')
	await get('/assets/main-abc123.js')

	await message({ keep: '/v/0.5.0/' })

	expect([...cache.keys()].map((u) => new URL(u).pathname).sort()).toEqual([
		'/assets/main-abc123.js',
		'/v/0.5.0/gui.js'
	])
})

it('ignores a message that is not a version to keep', async () => {
	await get('/v/0.4.1/gui.js')
	await message({ keep: '/' })
	await message('nonsense')
	expect(cache.size).toBe(1)
})

it('leaves cross-origin and non-GET requests alone', async () => {
	expect(await get('/v/0.4.1/gui.js')).not.toBeNull()

	// Another origin's bytes are not ours to cache or to answer for.
	expect(
		answered({ request: { url: 'https://example.com/tracker.js', method: 'GET', mode: 'cors' } })
	).toHaveLength(0)

	expect(answered({ request: { ...request('/'), method: 'POST', mode: 'navigate' } })).toHaveLength(
		0
	)
})
