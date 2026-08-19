import { appBundleFromMemory, kernel, type Message } from '@justfiles/app'
import { capabilityRegistry } from '@justfiles/app/capabilities'
import { volumeCapability } from '@justfiles/app/capabilities/volume/host'
import { sandboxClient } from '@justfiles/app/sandbox'
import '@justfiles/design/mac.css'
import { volume } from '@justfiles/fs'
import { idbStore, persistStorage } from '@justfiles/fs/idb'

// The page's platform entry: real TypeScript, bundled by Vite and served as a
// hashed static asset (see `route.get('/')` in ../app.tsx). Everything an app
// needs at runtime — kernel, volume, reducer — lives HERE, in the browser: the
// app already owns this origin, so there is nothing on the page to isolate it
// from, and the runner stays a router with no per-app compute. The app's own
// bytes are served by the runner out of the store, under `/v/{version}/`.

// Who this page is, and where its bytes live: inlined by the runner onto the
// mount node, so booting costs no `/manifest.json` round trip. Read first — a
// missing root is worth failing on before any of the machinery below exists.
const root = document.getElementById('app')
if (!root) throw new Error('missing app root')
const { id, name, version, base, app, gui: guiPath } = root.dataset
if (!id || !name || !base || !app || !guiPath) throw new Error('missing app identity')

// `base` is `/v/{version}/`, emitted by the document that resolved the live
// version. Every URL here hangs off it, so one page load can never mix bytes
// from two releases — and the integrity pins an installed device holds keep
// matching after the next publish. The entry points come from the manifest the
// same way, so an app that names its reducer something else still boots.

// The app's own GUI: resolved by the browser, not the build, so the specifier
// goes through a variable to stay out of Vite's import analysis. Started here
// and awaited at the end — it downloads while the kernel boots rather than
// after it.
const guiModule = import(/* @vite-ignore */ `${base}${guiPath}`)

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

// Browser-local and unsynced, per the hosted-app posture: this app's documents
// live in this browser, keyed by the app's own id.
const fs = volume(idbStore(`justapps:${id}`))
const k = kernel({
	fs,
	sandbox: async () => sandbox,
	clock: {},
	capabilities: capabilityRegistry({ volume: volumeCapability(fs) })
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

// The GUI's half of the SDK contract: actions in, committed state out. State
// flows one way — a dispatch's return value is ignored, the push is what renders.
const transport = {
	invoke: (message: Message) => k.dispatch(appId, message),
	subscribe: (onState: (state: unknown) => void) =>
		k.subscribe((event) => {
			if (event.type === 'app.update' && event.appId === appId) onState(event.state)
		})
}

const { gui } = await guiModule
gui.mount(root, await k.state(appId), { transport })

// This origin holds one app and its documents, and nothing here syncs anywhere,
// so eviction would be the only copy going. Asked for after mount, when the
// browser has an engagement signal to weigh — Chrome and Safari decide silently
// from one, and asking during boot is asking at the least convincing moment.
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
