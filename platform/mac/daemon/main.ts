import { randomBytes } from 'node:crypto'
import { dirname, resolve, sep } from 'node:path'
import type { AgentFrame, AgentRequest } from '@justfiles/agent/protocol'
import type { AppManifest } from '@justfiles/app/runtime'
import type { Server, ServerWebSocket } from 'bun'
import {
	abortAgent,
	agentCommands,
	agentSnapshot,
	dispatchCommand,
	promptAgent,
	setAgentBroadcast
} from './agent'
import {
	acquireDaemonLock,
	clearRuntime,
	getVolume,
	type NativeStorage,
	OwnerChangedError,
	startStorage,
	writeRuntime
} from './fs'
import { type Identity, identity } from './identity'
import { closeKernel, getKernel } from './kernel'
import { type ProjectionApp, reconcileProjection } from './materialize'
import { setNotificationChannel } from './notify'
import type { ClientMessage, ServerMessage } from './protocol'
import { type RuntimeRefresh, runtimeRefresh } from './refresh'
import { SHIPPED } from './resources'
import { sandboxes } from './sandbox'
import { installStoreApp, storeCatalog } from './store'

// The browser surfaces (launcher, chat, app shell, assets) are Vite-built
// into ui/dist/client and served verbatim. Shipped: beside the exe under Resources/client
// (import.meta.dirname is the bunfs root under --compile, so resolve off the exe path).
const CLIENT_DIR = SHIPPED
	? resolve(dirname(process.execPath), '..', 'Resources', 'client')
	: resolve(import.meta.dirname, '..', 'ui', 'dist', 'client')

// Serve a file from the client tree. The startsWith guard rejects `..` escapes; the
// explicit exists() 404 is required because a file Response from a handler 500s (not 404s)
// on a missing file mid-stream.
async function serveClient(rel: string): Promise<Response> {
	const path = resolve(CLIENT_DIR, rel)
	if (path !== CLIENT_DIR && !path.startsWith(CLIENT_DIR + sep))
		return new Response('Not Found', { status: 404 })
	const file = Bun.file(path)
	return (await file.exists()) ? new Response(file) : new Response('Not Found', { status: 404 })
}

function imageContentType(path: string, bytes: Uint8Array): string {
	const lower = path.toLowerCase()
	if (lower.endsWith('.svg') || new TextDecoder().decode(bytes.slice(0, 128)).includes('<svg')) {
		return 'image/svg+xml'
	}
	if (lower.endsWith('.png') || (bytes[0] === 0x89 && bytes[1] === 0x50)) return 'image/png'
	if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
	return 'application/octet-stream'
}

type Context = { type: 'system' } | { type: 'agent' } | { type: 'app'; id: string }

const runtimes = new WeakMap<Server<Context>, RuntimeRefresh>()

const failure = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// A failed store request: the response carries the message the tile shows, the log carries
// the fault itself — a launcher status line is no place to debug an install from.
const storeFault = (error: unknown): Response => {
	console.error('store:', error)
	return new Response(failure(error), { status: 502 })
}

// Loopback is reachable from any page in any browser on this Mac, and a bodyless POST needs
// no CORS preflight — so a route that mutates the Volume has to reject a cross-origin caller
// itself. Browsers always send `Origin` on a POST; a caller that sends none is not a page.
const crossOrigin = (req: Request): boolean => {
	const origin = req.headers.get('origin')
	return origin !== null && origin !== new URL(req.url).origin
}

// Typed send helpers — routing every frame through a union keeps the wire protocol
// compile-checked. `/system` speaks `ServerMessage`; `/agent` the shared `AgentFrame`.
const send = (ws: ServerWebSocket<Context>, message: ServerMessage) =>
	ws.send(JSON.stringify(message))
const sendAgent = (ws: ServerWebSocket<Context>, event: AgentFrame) =>
	ws.send(JSON.stringify(event))

export interface ServerOptions {
	// TCP port; default OS-ephemeral shipped (0) / a fixed 3000 in dev, honoring PORT.
	port?: number
	// OS `.app` projection; default reconciles the real bundles. Tests pass a no-op so a run
	// never touches ~/Applications (or runs codesign/lsregister).
	projectApps?: (apps: ProjectionApp[]) => Promise<void>
}

interface IdentityCommands {
	begin(): void
	end(): void
}

// Build the HTTP + WebSocket server: static client tree, per-app gui.js/icon routes, and
// the three sockets (`/system`, `/agent`, `/app/:id`). Pulls everything from the module
// singletons, so a test stands it up over a temp Volume with a no-op `projectApps`.
export function createServer(options: ServerOptions = {}): Server<Context> {
	return serve(options)
}

function serve(options: ServerOptions, identityCommands?: IdentityCommands): Server<Context> {
	const projectApps = options.projectApps ?? reconcileProjection
	const port = options.port ?? (process.env.PORT ? Number(process.env.PORT) : SHIPPED ? 0 : 3000)
	let refresh!: RuntimeRefresh

	const server = Bun.serve({
		// Loopback only (never Bun's default 0.0.0.0, which would expose us to the LAN).
		// Shipped: an ephemeral port (0), discovered via runtime.json, so installs never
		// collide. Dev: a fixed 3000 keeps the open tab alive across `bun --watch` restarts.
		hostname: '127.0.0.1',
		port,
		routes: {
			'/': () => serveClient('launcher/index.html'),
			// Chat-only surface the native launcher embeds in a transparent WKWebView.
			'/launcher/chat': () => serveClient('launcher/chat.html'),
			// The App Store, likewise — the native launcher has its own AppKit grid, so the store
			// reaches it as a page rather than as part of the web launcher.
			'/launcher/store': () => serveClient('launcher/store.html'),
			'/app/:id': () => serveClient('app/shell.html'),
			'/app/:id/gui.js': async (req) => {
				try {
					const k = await getKernel()
					const app = await k.app(req.params.id)
					const gui = await app.read('gui.js')
					return new Response(gui, {
						headers: { 'content-type': 'text/javascript', 'cache-control': 'no-store' }
					})
				} catch {
					// Unknown app / missing gui.js is a 404, not a 500 — like the icon route.
					return new Response('Not Found', { status: 404 })
				}
			},
			'/app/:id/icon': async (req) => {
				try {
					const k = await getKernel()
					const app = await k.app(req.params.id)
					if (!app.manifest.icon) return new Response('Not Found', { status: 404 })
					const icon = await app.read(app.manifest.icon)
					return new Response(icon, {
						headers: {
							'content-type': imageContentType(app.manifest.icon, icon),
							'cache-control': 'no-store'
						}
					})
				} catch {
					return new Response('Not Found', { status: 404 })
				}
			},
			'/app/:id/connect': (req) => {
				if (server.upgrade(req, { data: { type: 'app', id: req.params.id } })) return undefined
				return new Response('Expected WebSocket upgrade', { status: 426 })
			},
			// The App Store tile: browse what JustApps publishes, then install one by id at the
			// version the consent sheet showed. An install needs no reply beyond ok/failed —
			// landing it fires `app.installed`, which pushes a fresh catalog to every launcher,
			// and the tile's row drops out there.
			'/store': async () => {
				try {
					return Response.json({ apps: await storeCatalog() })
				} catch (error) {
					return storeFault(error)
				}
			},
			'/store/:id': {
				POST: async (req) => {
					if (crossOrigin(req)) return new Response('Forbidden', { status: 403 })
					// The version is the consent record: which release the sheet showed.
					const version = new URL(req.url).searchParams.get('version')
					if (!version) return new Response('version required', { status: 400 })
					try {
						await installStoreApp(await getKernel(), req.params.id, version)
						return new Response(null, { status: 204 })
					} catch (error) {
						return storeFault(error)
					}
				}
			},
			'/system': (req, server) => {
				if (server.upgrade(req, { data: { type: 'system' } })) return undefined
				return new Response('Expected WebSocket upgrade', { status: 426 })
			},
			'/agent': (req, server) => {
				if (server.upgrade(req, { data: { type: 'agent' } })) return undefined
				return new Response('Expected WebSocket upgrade', { status: 426 })
			},
			// Catch-all for the hashed Vite assets (/assets/*); specific routes win.
			'/*': (req) => serveClient(new URL(req.url).pathname.slice(1))
		},
		websocket: {
			data: {} as Context,

			async open(ws) {
				if (ws.data.type === 'agent') {
					// Live view of the one shared session: subscribe to the `agent` topic, then
					// send the current snapshot so the chat mounts on it.
					ws.subscribe('agent')
					sendAgent(ws, await agentSnapshot())
					return
				}
				if (ws.data.type === 'app') {
					// Pin the reducer worker for this window's lifetime (sync, before any await);
					// subscribe before refresh publishes the first state frame.
					sandboxes.retain(ws.data.id)
					ws.subscribe(`app:${ws.data.id}`)
					await refresh.openApp(ws.data.id)
					return
				}

				if (ws.data.type === 'system') {
					// Catalog + notifications fan out on their own topics; push the current
					// catalog + slash-command menu so the launcher mounts populated.
					ws.subscribe('catalog')
					ws.subscribe('notify')
					await refreshCatalog()
					send(ws, { type: 'commands', commands: await agentCommands() })
				}
			},
			async message(ws, message) {
				if (ws.data.type === 'agent') {
					// Admission replies to this socket. Session events publish to every chat.
					const req = JSON.parse(
						typeof message === 'string' ? message : message.toString()
					) as AgentRequest
					if (req.type === 'prompt') sendAgent(ws, await promptAgent(req.text))
					else if (req.type === 'abort') abortAgent(req.turnId)
					else if (req.type === 'snapshot') sendAgent(ws, await agentSnapshot())
					return
				}
				if (ws.data.type === 'app') {
					// Request/response: dispatch the flat `{id,type,params}` and reply keyed by
					// `id`. State changes flow back separately as `app:<id>` pushes.
					const { id, type, params } = JSON.parse(
						typeof message === 'string' ? message : message.toString()
					)
					const kernel = await getKernel()
					try {
						const value = await kernel.dispatch(ws.data.id, { type, params })
						ws.send(JSON.stringify({ id, ok: true, value }))
					} catch (err) {
						ws.send(JSON.stringify({ id, ok: false, error: failure(err) }))
					}
					return
				}
				// `/system`: dispatch a slash command and reply with what the launcher shows.
				const text = typeof message === 'string' ? message : message.toString()
				const parsed = JSON.parse(text) as ClientMessage
				if (parsed.type === 'command') {
					const mayChangeOwner = parsed.name === 'sign-in'
					if (mayChangeOwner) identityCommands?.begin()
					try {
						const result = await dispatchCommand(parsed.name)
						send(ws, { type: 'commandResult', id: parsed.id, result })
					} finally {
						if (mayChangeOwner) identityCommands?.end()
					}
					return
				}
				send(ws, { type: 'error', message: `Unknown command: ${text}` })
			},
			close(ws) {
				// Bun auto-unsubscribes on close; unpin the app's reducer worker so it's reaped.
				if (ws.data.type === 'app') {
					refresh.closeApp(ws.data.id)
					sandboxes.release(ws.data.id)
				}
			}
		}
	})

	// Fan `notify` capability calls + agent pings out to every launcher `/system` socket. A
	// notification raised before this / with no launcher connected is dropped (transient).
	setNotificationChannel((notification) =>
		server.publish(
			'notify',
			JSON.stringify({ type: 'notification', notification } satisfies ServerMessage)
		)
	)

	// Every agent turn publishes the shared lifecycle frames to each subscribed chat.
	setAgentBroadcast((event) => server.publish('agent', JSON.stringify(event satisfies AgentFrame)))

	// Project the catalog into ~/Applications/Kodama Apps/*.app (real macOS apps). One-way, the
	// Volume wins; previews stay out. Fire-and-forget — a projection failure never takes the
	// daemon down.
	async function project(installed: AppManifest[]): Promise<void> {
		const kernel = await getKernel()
		const apps: ProjectionApp[] = await Promise.all(
			installed
				.filter((app) => !app.id.startsWith('preview.'))
				.map(async (app) => ({
					id: app.id,
					name: app.name,
					version: app.version,
					iconPath: app.icon,
					iconBytes: app.icon ? await readIcon(kernel, app.id, app.icon) : undefined
				}))
		)
		await projectApps(apps)
	}

	async function readIcon(
		kernel: Awaited<ReturnType<typeof getKernel>>,
		id: string,
		path: string
	): Promise<Uint8Array | undefined> {
		try {
			return await (await kernel.app(id)).read(path)
		} catch {
			return undefined
		}
	}

	// Push the current catalog to every launcher `/system` socket.
	function publishCatalog(apps: AppManifest[]): void {
		server.publish('catalog', JSON.stringify({ type: 'apps', apps } satisfies ServerMessage))
	}

	async function refreshCatalog(): Promise<void> {
		const kernel = await getKernel()
		publishCatalog(await kernel.list())
	}

	refresh = runtimeRefresh({
		volume: getVolume(),
		kernel: getKernel(),
		publishState: (appId, state) => server.publish(`app:${appId}`, JSON.stringify({ state })),
		reloadApp: (appId) => server.publish(`app:${appId}`, JSON.stringify({ reload: true })),
		refreshApplications: async (apps) => {
			publishCatalog(apps)
			await project(apps)
		}
	})
	void refresh.refreshApps()
	runtimes.set(server, refresh)

	return server
}

export async function closeServerRuntime(server: Server<Context>): Promise<void> {
	const refresh = runtimes.get(server)
	runtimes.delete(server)
	await refresh?.close()
	await closeKernel()
}

// Is `pid` alive? macOS has no parent-death signal, so the owner watchdog polls this.
// kill(pid,0): ESRCH ⟹ gone; EPERM ⟹ alive but not ours.
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM'
	}
}

export interface DaemonOptions extends ServerOptions {
	identity?: Identity
	terminate?: () => void
}

export async function startDaemon(
	options: DaemonOptions = {}
): Promise<{ close(): Promise<void> } | null> {
	const lock = await acquireDaemonLock()
	if (!lock) return null

	const auth = options.identity ?? identity
	const token = randomBytes(16).toString('hex')
	let storage: NativeStorage | undefined
	let server: Server<Context> | undefined
	let closeOnce: Promise<void> | undefined
	let offIdentity: (() => void) | undefined
	let removeVolume = false
	let terminated = false
	let activeIdentityCommands = 0
	let identityCommandsDone = Promise.resolve()
	let finishIdentityCommands = (): void => {}
	const identityCommands: IdentityCommands = {
		begin() {
			if (activeIdentityCommands++ > 0) return
			identityCommandsDone = new Promise((resolve) => {
				finishIdentityCommands = resolve
			})
		},
		end() {
			if (--activeIdentityCommands === 0) finishIdentityCommands()
		}
	}
	const terminate = (): void => {
		if (terminated) return
		terminated = true
		options.terminate?.()
	}
	const close = (remove = false): Promise<void> => {
		removeVolume ||= remove
		if (remove) void storage?.stopSync()
		closeOnce ??= (async () => {
			try {
				offIdentity?.()
				server?.stop(true)
			} finally {
				try {
					if (!removeVolume) {
						const flushed = await storage?.flush()
						if (flushed === false) console.warn('daemon: final sync did not finish')
					}
					await storage?.stopSync()
				} finally {
					try {
						if (server) await closeServerRuntime(server)
					} finally {
						try {
							await storage?.close()
							if (removeVolume) await storage?.remove()
						} finally {
							try {
								await clearRuntime()
							} finally {
								await lock.release()
							}
						}
					}
				}
			}
		})()
		return closeOnce
	}

	try {
		const ownerId = await auth.ownerId()
		try {
			storage = await startStorage({
				ownerId,
				getToken: () => auth.getToken()
			})
		} catch (error) {
			if (!(error instanceof OwnerChangedError)) throw error
			await clearRuntime()
			await lock.release()
			return null
		}
		offIdentity = auth.onChange((user) => {
			// Sign-out only removes the token. The volume and daemon stay alive. A
			// later sign-in by the same owner can resume the existing sync session.
			if (!user) return
			if (user.id === storage?.ownerId) {
				void storage?.flush().catch((error) => console.warn('daemon: sync resume failed', error))
				return
			}
			void storage?.stopSync()
			// A different signed-in owner needs a new volume. Let the sign-in command
			// send its result before close tears down its socket.
			void identityCommandsDone
				.then(() => close(true))
				.catch((error) => console.error('daemon: failed to close after identity change', error))
				.finally(terminate)
		})
		server = serve(options, identityCommands)
		const port = server.port
		if (port === undefined) throw new Error('daemon: server has no TCP port')
		await writeRuntime({ port, token, pid: process.pid })
		return { close: () => close() }
	} catch (error) {
		try {
			await close()
		} catch (closeError) {
			console.error('daemon: failed to close after startup error', closeError)
		}
		throw error
	}
}

// Process entry: bind the daemon lifetime to its owning app. Importing this module for tests has
// no process-level side effects.
async function main(): Promise<void> {
	const daemon = await startDaemon({ terminate: () => process.exit(0) })
	if (!daemon) return
	let exiting = false
	const exit = async (): Promise<void> => {
		if (exiting) return
		exiting = true
		try {
			await daemon.close()
		} catch (error) {
			console.error('daemon: failed to close', error)
		}
		process.exit(0)
	}

	process.on('SIGINT', () => void exit())
	process.on('SIGTERM', () => void exit())
	process.on('beforeExit', () => void exit())

	const ownerPid = Number(process.env.FRIEREN_OWNER_PID)
	if (Number.isInteger(ownerPid) && ownerPid > 0) {
		const watchdog = setInterval(() => {
			if (!alive(ownerPid)) void exit()
		}, 1000)
		watchdog.unref()
	}
}

if (import.meta.main) void main()
