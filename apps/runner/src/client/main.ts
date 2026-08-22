import { appBundleFromMemory, kernel } from '@justfiles/app'
import { capabilityRegistry } from '@justfiles/app/capabilities'
import { volumeCapability } from '@justfiles/app/capabilities/volume/host'
import { guiHost } from '@justfiles/app/iframe'
import { sandboxClient } from '@justfiles/app/sandbox'
import { volume } from '@justfiles/fs'
import { httpStore } from '@justfiles/fs/http'
import { idbStore, persistStorage } from '@justfiles/fs/idb'
import { adoptOnce, migrateIdb } from '@justfiles/fs/migrate.idb'
import { onlineVolumeCapability } from './online-volume'

// The page's platform entry: real TypeScript, bundled by Vite and served as a
// hashed static asset (see `route.get('/')` in ../app.tsx). Everything an app
// needs at runtime — kernel, volume, reducer — lives HERE, in the trusted parent.
// The publisher's GUI runs in the opaque iframe below and receives one port.

// Who this page is, and where its bytes live: inlined by the runner onto the
// mount node, so booting costs no `/manifest.json` round trip. Read first — a
// missing root is worth failing on before any of the machinery below exists.
const root = document.getElementById('app')
if (!root) throw new Error('missing app root')
const {
	id,
	name,
	version,
	base,
	app,
	gui: guiPath,
	request: requestNonce,
	volumeScopes
} = root.dataset
if (!id || !name || !base || !app || !guiPath) throw new Error('missing app identity')

const framePlaceholder = document.getElementById('app-frame')
if (!(framePlaceholder instanceof HTMLIFrameElement)) throw new Error('missing app frame')
const frame = framePlaceholder.cloneNode() as HTMLIFrameElement
const frameLoaded = new Promise<void>((resolve) => frame.addEventListener('load', () => resolve()))
frame.src = '/gui-frame'
framePlaceholder.replaceWith(frame)

const errorElement = document.getElementById('app-error')
if (!errorElement) throw new Error('missing app error')

document.addEventListener('pointermove', (event) => {
	if (event.clientY < 46) document.body.classList.remove('runner-shelf-hidden')
})

// `base` is `/v/{version}/`, emitted by the document that resolved the live
// version. Every URL here hangs off it, so one page load can never mix bytes
// from two releases — and the integrity pins an installed device holds keep
// matching after the next publish. The entry points come from the manifest the
// same way, so an app that names its reducer something else still boots.

// The opaque frame imports this public release URL. Keeping the URL intact lets
// the GUI resolve companion files against import.meta.url.
const guiUrl = new URL(`${base}${guiPath}`, location.href).href

// `/worker.js` is the reducer isolate: HOST code, one body for every app and
// every release, so it carries no reducer URL of its own. This release's reducer
// is handed over as the Worker's `name`, which the isolate dynamic-imports —
// which is why the platform needs no per-release copy of itself under `/v/`.
const worker = new Worker('/worker.js', {
	type: 'module',
	name: new URL(`${base}${app}`, location.href).href
})
const { sandbox, fail } = sandboxClient({
	post: (message) => worker.postMessage(message),
	onMessage: (handler) => {
		worker.onmessage = (event) => handler(event.data)
	}
})
// A reducer that fails to load would otherwise leave every dispatch pending
// forever; reject them with the error the browser reported instead.
worker.onerror = (event) => fail(new Error(event.message || 'reducer worker failed'))

// The old database uses schema version 6, but `idbStore` opens version 1. Two
// names avoid a `VersionError` and let us copy the only local data once.
const LEGACY_DB = `justapps:${id}`
const STORE_DB = `justapps-store:${id}`
/**
 * Where the one pass is recorded. Re-running it only costs a re-read, but a pass
 * that ran again after the volume was live would copy stale rows over live ones —
 * rule 3 only makes an IDENTICAL row a no-op. Per app, because the databases are.
 */
const ADOPTED_KEY = `justapps-adopted:${id}`

const online = requestNonce !== undefined && volumeScopes !== undefined
const store = online
	? httpStore('/_runner/store', { headers: { 'x-runner-request': requestNonce } })
	: idbStore(STORE_DB)
if (!online) {
	// The lock and marker stop two tabs from copying stale rows over new writes.
	await adoptOnce(STORE_DB, async () => {
		if (localStorage.getItem(ADOPTED_KEY)) return
		await migrateIdb(LEGACY_DB, store)
		localStorage.setItem(ADOPTED_KEY, '1')
	})
}
const fs = volume(store)
const k = kernel({
	fs,
	sandbox: async () => sandbox,
	clock: {},
	capabilities: capabilityRegistry({
		volume: online
			? onlineVolumeCapability(fs, id, readVolumeScopes(volumeScopes))
			: volumeCapability(fs)
	})
})

// Install on every load: the bundle write is idempotent and state lives in the
// volume, keyed by app id, so a reload rehydrates rather than resets.
const appId = await k.install(
	appBundleFromMemory({
		id,
		name,
		version,
		app: await (await fetch(`${base}${app}`)).text()
	})
)

await frameLoaded
const { port1, port2 } = new MessageChannel()
const postState = guiHost(port1, {
	invoke: (message) => k.dispatch(appId, message),
	onError: (message) => {
		errorElement.textContent = `Failed to load app: ${message}`
		errorElement.hidden = false
	},
	onMessage: (message) => {
		if (message.type === 'shelf' && typeof message.hidden === 'boolean')
			document.body.classList.toggle('runner-shelf-hidden', message.hidden)
	}
})
k.subscribe((event) => {
	if (event.type === 'app.update' && event.appId === appId) postState(event.state)
})
frame.contentWindow?.postMessage({ type: 'boot', guiUrl, state: await k.state(appId) }, '*', [
	port2
])

// Ask after mount, when the browser has an engagement signal. Online data lives
// in Frieren, so only the signed-out store needs this protection from eviction.
if (!online)
	persistStorage().then((granted) => {
		if (!granted) console.warn('storage is best-effort: the browser may evict this app')
	})

// After mount, never before: the worker only earns its keep on the NEXT visit,
// so registering it earlier would spend first-paint time on nothing. It caches
// the shell and the platform bundle, which come from the network and would
// otherwise make this page unreachable offline however complete the volume is.
//
// Not in dev, where Vite serves unhashed modules and a cache would fight HMR.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
	navigator.serviceWorker
		.register('/sw.js')
		.then(() => navigator.serviceWorker.ready)
		// Which release to keep. The worker cannot know it — the version is only
		// resolved per request — so the page that was rendered for it says.
		.then((registration) => registration.active?.postMessage({ keep: base }))
		.catch(() => {})
}

function readVolumeScopes(value: string | undefined): string[][] {
	const parsed: unknown = JSON.parse(value ?? 'null')
	if (
		!Array.isArray(parsed) ||
		!parsed.every(
			(scopes) => Array.isArray(scopes) && scopes.every((scope) => typeof scope === 'string')
		)
	)
		throw new Error('invalid online volume scopes')
	return parsed
}
