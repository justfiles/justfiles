import { appBundleFromMemory, kernel, type Message } from '@justfiles/app'
import { capabilityRegistry } from '@justfiles/app/capabilities'
import { volumeCapability } from '@justfiles/app/capabilities/volume/host'
import { sandboxClient } from '@justfiles/app/sandbox'
import { volume } from '@justfiles/fs'
import { idbStorage } from '@justfiles/fs/storage/idb'

// The page's platform entry: real TypeScript, bundled by Vite and served as a
// hashed static asset (see `route.get('/')` in ../app.tsx). Everything an app
// needs at runtime — kernel, volume, reducer — lives HERE, in the browser: the
// app already owns this origin, so there is nothing on the page to isolate it
// from, and the runner stays a router with no per-app compute. The app's own
// bytes (`/app.js`, `/gui.js`, `/manifest.json`) are served by the runner out
// of the store.

// The app's own GUI, served at `/gui.js`: resolved by the browser, not the
// build, so the specifier goes through a variable to stay out of Vite's import
// analysis. Started here and awaited at the end — it downloads while the kernel
// boots rather than after it.
const guiUrl = '/gui.js'
const guiModule = import(/* @vite-ignore */ guiUrl)

// Who this page is: inlined by the runner onto the mount node, so booting costs
// no `/manifest.json` round trip. Read first — a missing root is worth failing on
// before any of the machinery below exists.
const root = document.getElementById('app')
if (!root) throw new Error('missing app root')
const { id, name, version } = root.dataset
if (!id || !name) throw new Error('missing app identity')

// `/worker.js` is the reducer isolate: platform code that imports `/app.js` and
// answers the kernel's host↔isolate protocol. One app per origin, so one worker.
const worker = new Worker('/worker.js', { type: 'module' })
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
const fs = volume(idbStorage(`justapps:${id}`))
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
		app: await (await fetch('/app.js')).text()
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
