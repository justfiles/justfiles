import { randomBytes } from 'node:crypto'
import { dirname, resolve, sep } from 'node:path'
import type { Server, ServerWebSocket } from 'bun'
import {
	abortAgent,
	agentCommands,
	agentHistory,
	dispatchCommand,
	promptAgent,
	setAgentBroadcast
} from './agent'
import { coalesce } from './coalesce'
import { clearRuntime, writeRuntime } from './fs'
import { getKernel } from './kernel'
import { type ProjectionApp, reconcileProjection } from './materialize'
import { setNotificationChannel } from './notify'
import type { AgentEvent, AgentRequest, ClientMessage, ServerMessage } from './protocol'
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

const failure = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// A failed store request: the response carries the message the tile shows, the log carries
// the fault itself — a launcher status line is no place to debug an install from.
const storeFault = (error: unknown): Response => {
	console.error('store:', error)
	return new Response(failure(error), { status: 502 })
}

// Typed send helpers — routing every frame through a union keeps the wire protocol
// compile-checked. `/system` speaks `ServerMessage`; `/agent` its own `AgentEvent`.
const send = (ws: ServerWebSocket<Context>, message: ServerMessage) =>
	ws.send(JSON.stringify(message))
const sendAgent = (ws: ServerWebSocket<Context>, event: AgentEvent) =>
	ws.send(JSON.stringify(event))

export interface ServerOptions {
	// TCP port; default OS-ephemeral shipped (0) / a fixed 3000 in dev, honoring PORT.
	port?: number
	// OS `.app` projection; default reconciles the real bundles. Tests pass a no-op so a run
	// never touches ~/Applications (or runs codesign/lsregister).
	projectApps?: (apps: ProjectionApp[]) => Promise<void>
}

// Build the HTTP + WebSocket server: static client tree, per-app gui.js/icon routes, and
// the three sockets (`/system`, `/agent`, `/app/:id`). Pulls everything from the module
// singletons, so a test stands it up over a temp Volume with a no-op `projectApps`.
export function createServer(options: ServerOptions = {}): Server<Context> {
	const projectApps = options.projectApps ?? reconcileProjection
	const port = options.port ?? (process.env.PORT ? Number(process.env.PORT) : SHIPPED ? 0 : 3000)

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
			// The App Store tile: browse what JustApps publishes, then install one by id. An
			// install needs no reply beyond ok/failed — landing it fires `app.installed`, which
			// pushes a fresh catalog to every launcher, and the tile's row drops out there.
			'/store': async () => {
				try {
					return Response.json({ apps: await storeCatalog() })
				} catch (error) {
					return storeFault(error)
				}
			},
			'/store/:id': {
				POST: async (req) => {
					try {
						await installStoreApp(await getKernel(), req.params.id)
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
					sendAgent(ws, { type: 'history', entries: [...(await agentHistory())] })
					sendAgent(ws, { type: 'busy', value: false })
					return
				}
				if (ws.data.type === 'app') {
					// Pin the reducer worker for this window's lifetime (sync, before any await);
					// subscribe before the first state frame so no update is missed.
					sandboxes.retain(ws.data.id)
					ws.subscribe(`app:${ws.data.id}`)
					const kernel = await getKernel()
					ws.send(JSON.stringify({ state: await kernel.state(ws.data.id) }))
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
					// The chat only sends prompts/abort; results come back on the `agent` topic.
					const req = JSON.parse(
						typeof message === 'string' ? message : message.toString()
					) as AgentRequest
					if (req.type === 'prompt') promptAgent(req.text)
					else if (req.type === 'abort') abortAgent()
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
					const result = await dispatchCommand(parsed.name)
					send(ws, { type: 'commandResult', id: parsed.id, result })
					return
				}
				send(ws, { type: 'error', message: `Unknown command: ${text}` })
			},
			close(ws) {
				// Bun auto-unsubscribes on close; unpin the app's reducer worker so it's reaped.
				if (ws.data.type === 'app') sandboxes.release(ws.data.id)
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

	// Every agent turn publishes its transcript + busy/error to the `agent` topic each chat
	// subscribes to — so a daemon-driven `/skill` turn surfaces live without polling.
	setAgentBroadcast((event) => server.publish('agent', JSON.stringify(event satisfies AgentEvent)))

	// Project the catalog into ~/Applications/Kodama Apps/*.app (real macOS apps). One-way, the
	// Volume wins; previews stay out. Fire-and-forget — a projection failure never takes the
	// daemon down.
	async function project(): Promise<void> {
		const kernel = await getKernel()
		const installed = (await kernel.list()).filter((app) => !app.id.startsWith('preview.'))
		const apps: ProjectionApp[] = await Promise.all(
			installed.map(async (app) => ({
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
	async function refreshCatalog(): Promise<void> {
		const kernel = await getKernel()
		const apps = await kernel.list()
		server.publish('catalog', JSON.stringify({ type: 'apps', apps } satisfies ServerMessage))
	}

	// A catalog mutation (ship / uninstall) refreshes every launcher's list and re-projects
	// the OS bundles. Coalesced so a burst collapses to one pass with no filesystem race.
	const reconcile = coalesce(async () => {
		await refreshCatalog()
		await project()
	})

	void project().catch((error) => console.error('daemon: projection failed', error))

	// One kernel subscription drives both: live-state fan-out per window, and the coalesced
	// reconcile on install/uninstall.
	getKernel().then((kernel) =>
		kernel.subscribe((event) => {
			if (event.type === 'app.update')
				server.publish(`app:${event.appId}`, JSON.stringify({ state: event.state }))
			else if (event.type === 'app.installed' || event.type === 'app.uninstalled') reconcile()
		})
	)

	return server
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

// Process entry: start the server, write the runtime.json handshake, and bind our lifetime
// to the owning app (FRIEREN_OWNER_PID watchdog + SIGINT/SIGTERM cleanup). Runs only as the
// entry, so an `import` of `createServer` for tests has no process-level side effects.
async function main(): Promise<void> {
	const token = randomBytes(16).toString('hex')
	let runtimeWritten = false
	let runtimeCleared = false

	const cleanupRuntime = async (): Promise<void> => {
		if (runtimeCleared || !runtimeWritten) return
		runtimeCleared = true
		try {
			await clearRuntime()
		} catch (error) {
			console.error('daemon: failed to clear runtime file', error)
		}
	}
	const exit = async (): Promise<void> => {
		await cleanupRuntime()
		process.exit(0)
	}

	process.on('SIGINT', () => void exit())
	process.on('SIGTERM', () => void exit())
	process.on('beforeExit', () => void cleanupRuntime())

	const ownerPid = Number(process.env.FRIEREN_OWNER_PID)
	if (Number.isInteger(ownerPid) && ownerPid > 0) {
		const watchdog = setInterval(() => {
			if (!alive(ownerPid)) void exit()
		}, 1000)
		watchdog.unref()
	}

	const server = createServer()
	const port = server.port
	if (port === undefined) throw new Error('daemon: server has no TCP port')
	await writeRuntime({ port, token, pid: process.pid })
	runtimeWritten = true
}

if (import.meta.main) void main()
