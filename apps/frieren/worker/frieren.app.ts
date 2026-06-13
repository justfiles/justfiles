import type { AppController, LLMText } from '@justfiles/agent'
import { type AppBundle, bundleFromZip, type Kernel, kernel, safeBundlePath } from '@justfiles/app'
import { type Catalog, reconcileBuiltins } from '@justfiles/app/builtins'
import {
	type Capabilities,
	type Capability,
	CapabilityError,
	capabilityRegistry,
	serveCapabilitiesRpc,
	wsFeedTransport
} from '@justfiles/app/capabilities'
import { volumeCapability } from '@justfiles/app/capabilities/volume/host'
import type { Volume } from '@justfiles/fs'
import { appFileUrl, CATALOG_PATH } from '../shared/appstore.ts'
import { aiCapability } from './ai.capability.ts'
import type { Integrations } from './integrations/registry.ts'
import { integrationsCapability } from './integrations.capability.ts'
import { workerSandbox } from './kernel.sandbox.ts'

interface DisplayApp {
	readonly id: string
	readonly name: string
	readonly description: string
	readonly iconUrl?: string
}

type AppBroadcast = { type: 'app_open'; id: string } | { type: 'app_close'; id: string }

interface FrierenAppsDeps {
	fs: Volume
	loader: Parameters<typeof workerSandbox>[0] | undefined
	// Static assets binding — serves the `/appstore` built-in app files seeded
	// into the volume on boot.
	assets: Fetcher
	sockets: () => Iterable<WebSocket>
	acceptWebSocket: (ws: WebSocket) => void
	text: LLMText
	broadcast: (msg: AppBroadcast) => void
	// Lazily resolved so frierenApps can be constructed before the
	// integrations registry exists; the volume capability does not need it.
	integrations?: () => Integrations
}

export interface FrierenApps {
	readonly kernel: Kernel
	readonly controller: AppController
	bundleFromZip(zip: Uint8Array): AppBundle
	list(): Promise<readonly DisplayApp[]>
	open(id: string): Promise<void>
	close(id?: string): Promise<void>
	asset(appId: string, path: string, version?: string): Promise<Response>
	acceptWebSocket(appId: string): Promise<Response>
	handleMessage(
		ws: WebSocket,
		appId: string | undefined,
		message: string | ArrayBuffer
	): Promise<void>
}

const OS_STATE_PATH = '/system/os-state.json'
const DEV_BUILTINS = import.meta.env.DEV

// Reserved pseudo-app id for the single shared capability-proxy socket. Not a
// valid app id (underscore is disallowed by the kernel), so it can't collide
// with a real app. The browser kernel opens ONE of these for every app's
// proxied capability calls; the target app id rides each frame.
const CAPS_SOCKET = '_caps'

export function frierenApps(deps: FrierenAppsDeps): FrierenApps {
	let kernelInstance: Kernel | undefined
	let subscribed = false
	let builtinsReady: Promise<void> | undefined

	// The server kernel's capability seam: `volume` and `ai` are local units;
	// `integrations` defers to the registry that `frierenApps` is built before, so
	// it resolves lazily per call. One wiring line replaces the old invoke/stream
	// `if`-chains.
	const ai = aiCapability(deps.text)
	const integrations: Capability = {
		invoke: async (call) => {
			const registry = deps.integrations?.()
			if (!registry)
				throw new CapabilityError('CAPABILITY_UNAVAILABLE', call.capability, call.method)
			return integrationsCapability(registry).invoke(call)
		},
		subscribe: async (call) => {
			throw new CapabilityError('CAPABILITY_UNAVAILABLE', call.capability, call.method)
		}
	}
	const capabilities: Capabilities = capabilityRegistry({
		volume: volumeCapability(deps.fs, { systemAllowlist: ['app.frieren.files'] }),
		ai,
		integrations
	})
	// What the browser may proxy over `_caps`: everything EXCEPT `volume`, which is
	// always served locally by the browser kernel against the synced volume and so
	// must never be re-served here. A `volume` frame misses this registry and comes
	// back as CAPABILITY_UNAVAILABLE — the old explicit rejection, now structural.
	const proxied: Capabilities = capabilityRegistry({ ai, integrations })

	function getKernel(): Kernel {
		if (kernelInstance) return kernelInstance
		if (!deps.loader) throw new Error('LOADER binding unavailable')
		kernelInstance = kernel({
			fs: deps.fs,
			sandbox: workerSandbox(deps.loader),
			clock: {},
			capabilities
		})
		return kernelInstance
	}

	// Built-in apps live as static `/appstore` assets and are seeded into the
	// user's volume on kernel use (this DO is the sole materializer for the synced
	// profile — see shared/appstore.ts). reconcileBuiltins reinstalls only the apps
	// whose bytes changed, so dev re-checks on every kernel use to pick up local
	// edits (cheap — unchanged apps are skipped); prod runs it once per instance.
	async function ensureBuiltinsInstalled(k: Kernel): Promise<void> {
		if (DEV_BUILTINS) return reconcileFromAssets(k)
		if (!builtinsReady) builtinsReady = reconcileFromAssets(k)
		return builtinsReady
	}

	async function reconcileFromAssets(k: Kernel): Promise<void> {
		const res = await deps.assets.fetch(assetRequest(CATALOG_PATH))
		if (!res.ok) return
		const catalog = (await res.json()) as Catalog
		await reconcileBuiltins(k, deps.fs, catalog, async (app, path) => {
			const file = await deps.assets.fetch(assetRequest(appFileUrl(app, path)))
			if (!file.ok) throw new Error(`appstore: ${app.id}/${path} ${file.status}`)
			return new Uint8Array(await file.arrayBuffer())
		})
	}

	async function kernelReady(): Promise<Kernel> {
		const k = getKernel()
		await ensureBuiltinsInstalled(k)
		return k
	}

	// kernel.subscribe's handler is in-memory, so it dies with the DO on
	// hibernation. Re-registered lazily per instance. On the server kernel
	// `app.update` fires only for the agent's own dispatches, so it nudges every
	// caps socket to pull: the agent changed this app server-side; pull now
	// instead of waiting for the next sync interval. The browser kernel renders
	// the pulled state via `volume.watch`.
	function ensureSubscribed(): void {
		if (subscribed) return
		subscribed = true
		getKernel().subscribe((event) => {
			if (event.type !== 'app.update') return
			for (const socket of deps.sockets()) {
				const attachment = socket.deserializeAttachment() as { caps?: boolean } | null
				if (attachment?.caps && freshSocket(socket)) linkFor(socket).dirty(event.appId)
			}
		})
	}

	async function inspect(id: string) {
		const k = await kernelReady()
		const installed = await k.app(id)
		const [state, actions] = await Promise.all([k.state(id).catch(() => undefined), k.actions(id)])
		return {
			id: installed.manifest.id,
			name: installed.manifest.name,
			description: '',
			state: state ?? null,
			actions
		}
	}

	async function list(): Promise<readonly DisplayApp[]> {
		try {
			const manifests = await (await kernelReady()).list()
			return manifests.map((m) => ({
				id: m.id,
				name: m.name,
				description: m.description ?? '',
				iconUrl:
					m.icon && m.version ? appFileUrl({ id: m.id, version: m.version }, m.icon) : undefined
			}))
		} catch {
			return []
		}
	}

	async function currentAppId(): Promise<string | undefined> {
		try {
			if (!(await deps.fs.exists(OS_STATE_PATH))) return undefined
			const snapshot = JSON.parse(
				new TextDecoder().decode(await deps.fs.readFile(OS_STATE_PATH))
			) as {
				windows?: Record<string, { appId?: unknown } | undefined>
				focusStack?: unknown
				openOrder?: unknown
			}
			for (const ids of [snapshot.focusStack, snapshot.openOrder]) {
				if (!Array.isArray(ids)) continue
				for (let i = ids.length - 1; i >= 0; i--) {
					const id = ids[i]
					if (typeof id !== 'string') continue
					const appId = snapshot.windows?.[id]?.appId
					if (typeof appId === 'string') return appId
				}
			}
		} catch {
			return undefined
		}
		return undefined
	}

	async function open(id: string): Promise<void> {
		deps.broadcast({ type: 'app_open', id })
	}

	async function close(id?: string): Promise<void> {
		const target = id ?? (await currentAppId())
		if (!target) return
		deps.broadcast({ type: 'app_close', id: target })
	}

	async function asset(appId: string, path: string, version?: string): Promise<Response> {
		let safe: string
		try {
			safe = safeBundlePath(path)
		} catch {
			return new Response(null, { status: 404 })
		}
		try {
			const installed = await (await kernelReady()).app(appId)
			const data = await installed.read(safe)
			const body = new ArrayBuffer(data.byteLength)
			new Uint8Array(body).set(data)
			const headers: Record<string, string> = { 'content-type': mimeFor(safe) }
			if (DEV_BUILTINS) {
				headers['cache-control'] = 'no-store'
			} else if (version && installed.manifest.version && version === installed.manifest.version) {
				// When the URL pins the manifest version, the byte stream is
				// immutable for that URL — browsers re-use the cached entry on
				// re-launch within the token's lifetime, and a version bump in
				// list() drives a fresh fetch via a different URL.
				headers['cache-control'] = 'private, max-age=31536000, immutable'
			}
			return new Response(body, { headers })
		} catch {
			return new Response(null, { status: 404 })
		}
	}

	// ── Capability proxy transport ──────────────────────────────────────
	//
	// The browser kernel opens ONE caps socket (`/api/apps/_caps/ws`) per session
	// and drives the package `proxyCapabilitiesRpc` over it; this side runs the
	// matching `serveCapabilitiesRpc` against the `proxied` registry on a Cap'n Web
	// session. The DO delivers frames via `webSocketMessage` (hibernation model),
	// so `wsFeedTransport` exposes a `feed` the message handler pushes raw frames
	// into; replies and server→client `dirty` pushes go back over `ws.send`.
	const capsLinks = new WeakMap<
		WebSocket,
		{ feed: (frame: string) => void; dirty: (appId: string) => void }
	>()
	// Sockets whose Cap'n Web session was established in THIS instance. A session's
	// import/export tables live only in memory, so they die on hibernation; the
	// WeakSet (also in-memory) is empty after a wake. `freshSocket` uses that to
	// tell an apt socket from a stale, post-hibernation one.
	const acceptedThisInstance = new WeakSet<WebSocket>()

	function linkFor(ws: WebSocket) {
		let link = capsLinks.get(ws)
		if (!link) {
			const { transport, feed } = wsFeedTransport(ws)
			const served = serveCapabilitiesRpc(transport, proxied)
			link = { feed, dirty: served.dirty }
			capsLinks.set(ws, link)
		}
		return link
	}

	// A Cap'n Web session cannot continue across hibernation — a fresh server
	// session can't resolve the live browser session's import/export ids ("no such
	// export id"). So after a wake, close a socket the browser is still using and
	// let it reconnect a clean session, rather than serving on a desynced one.
	function freshSocket(ws: WebSocket): boolean {
		if (acceptedThisInstance.has(ws)) return true
		ws.close(1012, 'reconnect')
		return false
	}

	async function acceptWebSocket(appId: string): Promise<Response> {
		// `_caps` is the only WS the browser opens here: no app id, no state push.
		if (appId !== CAPS_SOCKET) return new Response(null, { status: 404 })
		const { 0: client, 1: server } = new WebSocketPair()
		deps.acceptWebSocket(server)
		server.serializeAttachment({ caps: true })
		acceptedThisInstance.add(server)
		// Subscribe so the agent's server-side writes nudge this tab to pull.
		ensureSubscribed()
		return new Response(null, { status: 101, webSocket: client })
	}

	// `appId` is undefined for the shared caps socket — the target app id rides
	// each capability call; the Cap'n Web session reads it off the frame.
	async function handleMessage(
		ws: WebSocket,
		_appId: string | undefined,
		message: string | ArrayBuffer
	): Promise<void> {
		if (typeof message !== 'string') return
		if (!freshSocket(ws)) return
		linkFor(ws).feed(message)
	}

	const controller: AppController = {
		list: async () =>
			(await list()).map(({ id, name, description }) => ({ id, name, description })),
		launch: async (id) => {
			const app = await inspect(id)
			await open(id)
			return app
		},
		close: async (id?: string) => {
			await close(id)
		},
		current: async () => {
			const id = await currentAppId()
			return id ? await inspect(id).catch(() => undefined) : undefined
		},
		inspect,
		state: async (id) => await (await kernelReady()).state(id),
		run: async (id, action, params) => {
			ensureSubscribed()
			return await (await kernelReady()).dispatch(id, { type: action, params, actor: 'agent' })
		}
	}

	return {
		get kernel() {
			return getKernel()
		},
		controller,
		bundleFromZip,
		list,
		open,
		close,
		asset,
		acceptWebSocket,
		handleMessage
	}
}

// The `ASSETS` binding ignores the host; only the path matters.
function assetRequest(path: string): Request {
	return new Request(`https://assets.invalid${path}`)
}

const MIME: Record<string, string> = {
	html: 'text/html; charset=utf-8',
	js: 'application/javascript; charset=utf-8',
	mjs: 'application/javascript; charset=utf-8',
	css: 'text/css; charset=utf-8',
	json: 'application/json; charset=utf-8',
	svg: 'image/svg+xml',
	wasm: 'application/wasm',
	wad: 'application/octet-stream',
	cfg: 'text/plain; charset=utf-8',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	webp: 'image/webp'
}

function mimeFor(path: string): string {
	const ext = path.split('.').pop()?.toLowerCase() ?? ''
	return MIME[ext] ?? 'application/octet-stream'
}
