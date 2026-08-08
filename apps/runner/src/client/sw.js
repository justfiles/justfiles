/**
 * The runner's service worker.
 *
 * Without one there is no offline story at all: the shell document and the
 * platform bundle come from the network, so an app whose reducer and documents
 * are already in the volume is still unreachable. It carries more here than in a
 * host that mounts app bytes through the kernel — this page installs with
 * `appBundleFromMemory` and loads `gui.js` as an ordinary module import, so the
 * HTTP cache is the only thing that holds the GUI.
 *
 * Served as text by the Worker (see `/sw.js` in ../app.tsx) rather than shipped
 * as a build asset, so it needs no build-tool integration and its scope is the
 * origin root by construction.
 */

const CACHE = 'justapps'

// Take over immediately. One app per origin, and the pages this could disrupt
// are the ones that would otherwise go a whole visit uncached.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

/** Frozen by construction: `/v/{version}/…` never changes, `/assets/…` is content-hashed. */
const immutable = (path) => path.startsWith('/v/') || path.startsWith('/assets/')

self.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url)
	if (event.request.method !== 'GET' || url.origin !== self.location.origin) return

	if (immutable(url.pathname)) event.respondWith(cacheFirst(event.request))
	else if (event.request.mode === 'navigate') event.respondWith(networkFirst(event.request))
})

/** Frozen bytes never need revalidating, so a hit is the end of it. */
async function cacheFirst(request) {
	const cache = await caches.open(CACHE)
	const hit = await cache.match(request)
	if (hit) return hit

	const response = await fetch(request)
	if (response.ok) await cache.put(request, response.clone())
	return response
}

/**
 * The document names the live version, so a cached one can pin the page to a
 * release that has since been superseded. The network wins; the cached copy is
 * the offline fallback and nothing more.
 */
async function networkFirst(request) {
	const cache = await caches.open(CACHE)
	try {
		const response = await fetch(request)
		if (response.ok) await cache.put(request, response.clone())
		return response
	} catch (offline) {
		const hit = await cache.match(request)
		if (hit) return hit
		throw offline
	}
}

/**
 * The page reports the release it was rendered for, and everything cached under
 * a different `/v/` prefix is dropped.
 *
 * Workbox sweeps on `activate` against a manifest known at build time. Here the
 * live version is only known at runtime, so the page has to say — and without
 * this the cache grows by a whole bundle per release, which for a real app is
 * ~10 MB a time against a quota the volume is also spending.
 */
self.addEventListener('message', (event) => {
	const keep = event.data?.keep
	if (typeof keep === 'string' && keep.startsWith('/v/')) event.waitUntil(sweep(keep))
})

async function sweep(keep) {
	const cache = await caches.open(CACHE)
	for (const request of await cache.keys()) {
		const { pathname } = new URL(request.url)
		if (pathname.startsWith('/v/') && !pathname.startsWith(keep)) await cache.delete(request)
	}
}
