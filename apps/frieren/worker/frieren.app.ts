import { type AppController, aiCapability, type LLMText, type OsWindowInfo } from '@justfiles/agent'
import { createAppController, type Kernel, kernel } from '@justfiles/app'
import {
	type Capabilities,
	type Capability,
	capabilityRegistry,
	serveCapabilitiesRpc,
	wsFeedTransport
} from '@justfiles/app/capabilities'
import { volumeCapability } from '@justfiles/app/capabilities/volume/host'
import type { Volume } from '@justfiles/fs'
import { appFileUrl } from '../shared/appstore.ts'
import { CAPS_WS_SUBPROTOCOL, offersCapsSubprotocol } from '../shared/caps-ws.ts'
import { workerSandbox } from './kernel.sandbox.ts'
import { currentAppId, readWindows } from './os-windows.ts'

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
	acceptWebSocket: (ws: WebSocket) => void
	text: LLMText
	broadcast: (msg: AppBroadcast) => void
	// The account-backed capabilities, built from the Volume store by the DO (which
	// also guards email/calendar with audit + rate-limit) and shared with the agent.
	// The volume + ai capabilities are local to this kernel; these are the rest.
	image: Capability
	email: Capability
	calendar: Capability
	// The host admin surface (the first-party Settings app's back-channel).
	settings: Capability
}

export interface FrierenApps {
	readonly controller: AppController
	dispose(): void
	// The agent's `os windows` port: the persisted shell snapshot, projected.
	windows(): Promise<readonly OsWindowInfo[]>
	list(): Promise<readonly DisplayApp[]>
	open(id: string): Promise<void>
	close(id?: string): Promise<void>
	acceptWebSocket(appId: string, offeredProtocols?: string | null): Promise<Response>
	handleMessage(
		ws: WebSocket,
		appId: string | undefined,
		message: string | ArrayBuffer
	): Promise<void>
}

// Reserved pseudo-app id for the single shared capability-proxy socket. Not a
// valid app id (underscore is disallowed by the kernel), so it can't collide
// with a real app. The browser kernel opens ONE of these for every app's
// proxied capability calls; the target app id rides each frame.
const CAPS_SOCKET = '_caps'

export function frierenApps(deps: FrierenAppsDeps): FrierenApps {
	let kernelInstance: Kernel | undefined
	let disposed = false

	// The server kernel's capability seam: `volume` and `ai` are local units; the
	// account-backed `email`/`calendar` and the `settings` admin surface are handed in
	// ready (built over the Volume store, guarded with audit + rate-limit). `ai` composes
	// purpose-scoped context (learning) from the Volume internally, and generates over the
	// resolved text service.
	const ai = aiCapability({
		volume: deps.fs,
		generate: ({ system, prompt }) => deps.text.gen(system, prompt)
	})
	const capabilities: Capabilities = capabilityRegistry({
		volume: volumeCapability(deps.fs, { systemAllowlist: ['app.justfiles.frieren.files'] }),
		ai,
		image: deps.image,
		email: deps.email,
		calendar: deps.calendar,
		settings: deps.settings
	})
	// What the browser may proxy over `_caps`: everything EXCEPT `volume`, which is
	// always served locally by the browser kernel against the synced volume and so
	// must never be re-served here. A `volume` frame misses this registry and comes
	// back as CAPABILITY_UNAVAILABLE — the old explicit rejection, now structural.
	// `settings` is here because the browser half delegates the methods only this side
	// can serve (`accounts.*`, `host.usage`) to it.
	const proxied: Capabilities = capabilityRegistry({
		ai,
		image: deps.image,
		email: deps.email,
		calendar: deps.calendar,
		settings: deps.settings
	})

	function getKernel(): Kernel {
		if (disposed) throw new Error('Runtime reset while the app was running. Try again.')
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

	// Built-in apps are materialised client-side only: the browser seeds an empty volume
	// once and syncs the record up. This DO never materialises `/applications/*` — it
	// holds whatever the client synced up and serves it to the agent, so the kernel is
	// used as-is with no server-side seed/reconcile.
	//
	// It needs no asset fetcher either. A hosted app's GUI is mounted from the origin
	// (#376), but the DO only ever reads `manifest.app`, and the reducer stays in the
	// volume precisely so a headless kernel never depends on an origin that serves only
	// the current release.

	async function list(): Promise<readonly DisplayApp[]> {
		try {
			const manifests = await getKernel().list()
			return manifests.map((m) => ({
				id: m.id,
				name: m.name,
				description: m.description ?? '',
				iconUrl:
					m.icon && m.baseUrl
						? `${m.baseUrl.replace(/\/$/, '')}/${m.icon}`
						: m.icon && m.version
							? appFileUrl({ id: m.id, version: m.version }, m.icon)
							: undefined
			}))
		} catch {
			return []
		}
	}

	async function open(id: string): Promise<void> {
		deps.broadcast({ type: 'app_open', id })
	}

	async function close(id?: string): Promise<void> {
		const target = id ?? (await currentAppId(deps.fs))
		if (!target) return
		deps.broadcast({ type: 'app_close', id: target })
	}

	// ── Capability proxy transport ──────────────────────────────────────
	//
	// The browser kernel opens ONE caps socket (`/api/apps/_caps/ws`) per session
	// and drives the package `proxyCapabilitiesRpc` over it; this side runs the
	// matching `serveCapabilitiesRpc` against the `proxied` registry on a Cap'n Web
	// session. The DO delivers frames via `webSocketMessage` (hibernation model),
	// so `wsFeedTransport` exposes a `feed` the message handler pushes raw frames
	// into; replies go back over `ws.send`. (The server->client volume poke rides the
	// session `/ws` socket as a `sync` frame, not this capability session.)
	const capsLinks = new WeakMap<WebSocket, { feed: (frame: string) => void }>()
	// Sockets whose Cap'n Web session was established in THIS instance. A session's
	// import/export tables live only in memory, so they die on hibernation; the
	// WeakSet (also in-memory) is empty after a wake. `freshSocket` uses that to
	// tell an apt socket from a stale, post-hibernation one.
	const acceptedThisInstance = new WeakSet<WebSocket>()

	function linkFor(ws: WebSocket) {
		let link = capsLinks.get(ws)
		if (!link) {
			const { transport, feed } = wsFeedTransport(ws)
			// Scopes ride the wire, resolved by the browser kernel from the executing
			// bundle's manifest (rpc.ts), so the served registry authorizes against the
			// same bundle version that is running the call.
			serveCapabilitiesRpc(transport, proxied)
			link = { feed }
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

	async function acceptWebSocket(
		appId: string,
		offeredProtocols?: string | null
	): Promise<Response> {
		// `_caps` is the only WS the browser opens here: no app id, no state push.
		if (appId !== CAPS_SOCKET) return new Response(null, { status: 404 })
		const { 0: client, 1: server } = new WebSocketPair()
		deps.acceptWebSocket(server)
		server.serializeAttachment({ caps: true })
		acceptedThisInstance.add(server)
		// The current client opens this socket offering `[CAPS_WS_SUBPROTOCOL,
		// bearer.<token>]` (the token rides the handshake, not the URL) and expects
		// the server to select one — the `ws`-based dev bridge rejects the handshake
		// otherwise — so echo the marker back, never the token. A pre-deploy client
		// still on the `?token=` query path offers none; echoing anyway would make the
		// browser reject its 101 (a server may only select an offered protocol), so
		// leave it unset for them.
		const headers = offersCapsSubprotocol(offeredProtocols ?? null)
			? { 'Sec-WebSocket-Protocol': CAPS_WS_SUBPROTOCOL }
			: undefined
		return new Response(null, { status: 101, webSocket: client, headers })
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

	// The agent↔kernel bridge (@justfiles/app). frieren's ports: apps surface as
	// broadcasts to the tabs (not native windows), "current" comes from the persisted
	// OS state. The server→client pull nudge is no longer armed here: the DO's fs
	// change feed broadcasts a `sync` frame to the session sockets for every
	// server-side write, agent dispatch included.
	const controller: AppController = createAppController(async () => getKernel(), {
		windows: {
			open: (id) => deps.broadcast({ type: 'app_open', id }),
			close: (id) => deps.broadcast({ type: 'app_close', id })
		},
		focus: () => currentAppId(deps.fs)
	})

	return {
		controller,
		dispose: () => {
			disposed = true
			kernelInstance?.dispose()
		},
		windows: () => readWindows(deps.fs),
		list,
		open,
		close,
		acceptWebSocket,
		handleMessage
	}
}
