import type { AppController, LLMText } from '@justfiles/agent'
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
import { aiCapability } from './ai.capability.ts'
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
	sockets: () => Iterable<WebSocket>
	acceptWebSocket: (ws: WebSocket) => void
	text: LLMText
	broadcast: (msg: AppBroadcast) => void
	// The account-backed capabilities, built from the Volume store by the DO (which
	// also guards email/calendar with audit + rate-limit) and shared with the agent.
	// The volume + ai capabilities are local to this kernel; these are the rest.
	image: Capability
	email: Capability
	calendar: Capability
	accounts: Capability
}

export interface FrierenApps {
	readonly controller: AppController
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

const OS_STATE_PATH = '/system/os-state.json'

// Reserved pseudo-app id for the single shared capability-proxy socket. Not a
// valid app id (underscore is disallowed by the kernel), so it can't collide
// with a real app. The browser kernel opens ONE of these for every app's
// proxied capability calls; the target app id rides each frame.
const CAPS_SOCKET = '_caps'

export function frierenApps(deps: FrierenAppsDeps): FrierenApps {
	let kernelInstance: Kernel | undefined
	let subscribed = false

	// The server kernel's capability seam: `volume` and `ai` are local units; the
	// account-backed `email`/`calendar`/`accounts` are handed in ready (built over
	// the Volume store, guarded with audit + rate-limit).
	const ai = aiCapability(deps.text)
	const capabilities: Capabilities = capabilityRegistry({
		volume: volumeCapability(deps.fs, { systemAllowlist: ['computer.spud.files'] }),
		ai,
		image: deps.image,
		email: deps.email,
		calendar: deps.calendar,
		accounts: deps.accounts
	})
	// What the browser may proxy over `_caps`: everything EXCEPT `volume`, which is
	// always served locally by the browser kernel against the synced volume and so
	// must never be re-served here. A `volume` frame misses this registry and comes
	// back as CAPABILITY_UNAVAILABLE — the old explicit rejection, now structural.
	const proxied: Capabilities = capabilityRegistry({
		ai,
		image: deps.image,
		email: deps.email,
		calendar: deps.calendar,
		accounts: deps.accounts
	})

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

	// Built-in apps are materialised client-side only: the browser seeds an empty
	// volume once and syncs the bundle up. This DO never materialises
	// `/applications/*` — it holds whatever the client synced up and serves it to
	// the agent, so the kernel is used as-is with no server-side seed/reconcile.

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

	async function list(): Promise<readonly DisplayApp[]> {
		try {
			const manifests = await getKernel().list()
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
		// Subscribe so the agent's server-side writes nudge this tab to pull.
		ensureSubscribed()
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
	// OS state, and the kernel accessor also arms the caps-socket nudge (ensureSubscribed)
	// so the agent's server-side dispatches push a pull to open browsers.
	const controller: AppController = createAppController(
		async () => {
			ensureSubscribed()
			return getKernel()
		},
		{
			windows: {
				open: (id) => deps.broadcast({ type: 'app_open', id }),
				close: (id) => deps.broadcast({ type: 'app_close', id })
			},
			focus: currentAppId
		}
	)

	return {
		controller,
		list,
		open,
		close,
		acceptWebSocket,
		handleMessage
	}
}
