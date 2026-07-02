import { randomBytes } from 'node:crypto'
import { dirname, resolve, sep } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { SHIPPED } from '../quayd/resources'
import {
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
import { sandboxes } from './sandbox'

// The browser surfaces (launcher, chat, app shell, their hashed assets, and the shared
// React import-map vendor bundles) are built by Vite into ui/dist/client and served
// verbatim from there — the daemon does zero frontend bundling. Shipped, the tree rides
// beside the exe under Quay.app/Contents/Resources/client (native/build.sh copies it); in
// dev it's ui/dist/client. `import.meta.dirname` is the bunfs root under --compile, so the
// shipped branch resolves against the real exe path instead.
const CLIENT_DIR = SHIPPED
	? resolve(dirname(process.execPath), '..', 'Resources', 'client')
	: resolve(import.meta.dirname, '..', 'ui', 'dist', 'client')

// Serve a file from the built client tree. `resolve` + the startsWith guard reject any
// `..` escape; Bun infers the Content-Type from the extension. The explicit `exists()`
// 404 is required because Bun's native "file route" 404 only applies to a Response used
// directly as a route VALUE — a file Response returned from a handler (our `/*` catch-all)
// 500s on a missing file mid-stream instead, so we check first.
async function serveClient(rel: string): Promise<Response> {
	const path = resolve(CLIENT_DIR, rel)
	if (path !== CLIENT_DIR && !path.startsWith(CLIENT_DIR + sep))
		return new Response('Not Found', { status: 404 })
	const file = Bun.file(path)
	return (await file.exists()) ? new Response(file) : new Response('Not Found', { status: 404 })
}
const token = randomBytes(16).toString('hex')
let runtimeWritten = false
let runtimeCleared = false

async function cleanupRuntime(): Promise<void> {
	if (runtimeCleared || !runtimeWritten) return
	runtimeCleared = true
	try {
		await clearRuntime()
	} catch (error) {
		console.error('quay daemon: failed to clear runtime file', error)
	}
}

async function exit(): Promise<void> {
	await cleanupRuntime()
	process.exit(0)
}

process.on('SIGINT', () => void exit())
process.on('SIGTERM', () => void exit())
process.on('beforeExit', () => void cleanupRuntime())

// Bind our lifetime to the owning app. The launcher passes its PID as QUAY_OWNER_PID
// when it spawns us (booters don't, so a Spotlight-launched window's daemon outlives
// it). macOS has no parent-death signal, so we poll: kill(pid,0) is a cheap liveness
// probe, and when the owner is gone — quit OR hard kill — we exit too, so the
// background daemon never outlives the app. ESRCH ⟹ gone; EPERM ⟹ alive but not ours.
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM'
	}
}

const ownerPid = Number(process.env.QUAY_OWNER_PID)
if (Number.isInteger(ownerPid) && ownerPid > 0) {
	const watchdog = setInterval(() => {
		if (!alive(ownerPid)) void exit()
	}, 1000)
	watchdog.unref()
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

// Single typed exit point for client-bound messages; routing every send through
// the `ServerMessage` union is what makes the wire protocol checked at compile time.
const send = (ws: ServerWebSocket<Context>, message: ServerMessage) =>
	ws.send(JSON.stringify(message))
// The `/agent` socket carries its own union (a live view of the session).
const sendAgent = (ws: ServerWebSocket<Context>, event: AgentEvent) =>
	ws.send(JSON.stringify(event))

const server = Bun.serve({
	// Loopback only — never 0.0.0.0 (Bun's default), which would expose the daemon to the
	// LAN. Shipped, take an OS-assigned ephemeral port (0) so two installs/versions never
	// fight over a fixed number and "port in use" can't happen; the native shell discovers
	// it via runtime.json (browser surfaces are same-origin, so they don't care). In dev a
	// fixed 3000 (overridable via PORT) keeps the open tab alive across `bun --watch` restarts.
	hostname: '127.0.0.1',
	port: process.env.PORT ? Number(process.env.PORT) : SHIPPED ? 0 : 3000,
	routes: {
		'/': () => serveClient('launcher/index.html'),
		// The native launcher embeds this chat-only surface in a transparent WKWebView; it
		// subscribes to the daemon's /agent socket (live transcript) and sends prompts.
		'/launcher/chat': () => serveClient('launcher/chat.html'),
		'/app/:id': () => serveClient('app/shell.html'),
		'/app/:id/gui.js': async (req) => {
			const id = req.params.id
			const k = await getKernel()
			const app = await k.app(id)
			const gui = await app.read('gui.js')
			return new Response(gui, {
				headers: { 'content-type': 'text/javascript', 'cache-control': 'no-store' }
			})
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
		'/system': (req, server) => {
			// Upgrade to a WebSocket; Bun replies with 101 on success.
			if (server.upgrade(req, { data: { type: 'system' } })) return undefined
			return new Response('Expected WebSocket upgrade', { status: 426 })
		},
		'/agent': (req, server) => {
			if (server.upgrade(req, { data: { type: 'agent' } })) return undefined
			return new Response('Expected WebSocket upgrade', { status: 426 })
		},
		// Static assets from the Vite build: /assets/* (hashed JS/CSS) and /vendor/* (the
		// shared React bundles). Bun matches the specific routes above first, so they win.
		'/*': (req) => serveClient(new URL(req.url).pathname.slice(1))
	},
	websocket: {
		data: {} as Context,

		async open(ws) {
			if (ws.data.type === 'agent') {
				// The chat is a live view of the shared session: subscribe to the `agent` topic
				// (every turn broadcasts the transcript there), then send this socket the current
				// snapshot so it mounts on it. No per-connection agent build — one shared session.
				ws.subscribe('agent')
				sendAgent(ws, { type: 'history', entries: [...(await agentHistory())] })
				sendAgent(ws, { type: 'busy', value: false })
				return
			}
			if (ws.data.type === 'app') {
				// Pin the app's reducer worker for the lifetime of this window (sync,
				// before any await) — `close` releases it, and once the last window
				// closes the sandbox pool reaps the worker after its idle grace.
				sandboxes.retain(ws.data.id)
				// Subscribe first so no state update is missed, then push the current
				// state as the first frame — the GUI mounts on it. Every later update
				// arrives on the same `app:<id>` topic via the kernel bridge below.
				ws.subscribe(`app:${ws.data.id}`)
				const kernel = await getKernel()
				ws.send(JSON.stringify({ state: await kernel.state(ws.data.id) }))
				return
			}

			if (ws.data.type === 'system') {
				ws.subscribe('catalog')
				// Notifications fan out to the same launcher audience on their own topic
				// (app `notify` calls + agent pings); the native sink projects them to banners.
				ws.subscribe('notify')
				// Send the freshly-connected launcher the current catalog (publish reaches
				// this socket too — it just subscribed above).
				await refreshCatalog()
				// Push the slash-command catalogue (built-ins + skills) so the launcher's `/`
				// menu populates; dispatch rides this same /system socket (see message()).
				send(ws, { type: 'commands', commands: await agentCommands() })
			}
		},
		async message(ws, message) {
			if (ws.data.type === 'agent') {
				// The chat only ever sends prompts; the turn's result comes back on the `agent`
				// topic (a fresh transcript), not as a reply to this frame.
				const req = JSON.parse(
					typeof message === 'string' ? message : message.toString()
				) as AgentRequest
				if (req.type === 'prompt') promptAgent(req.text)
				return
			}
			if (ws.data.type === 'app') {
				// Plain request/response: the GUI's generated client sends a flat
				// `{id,type,params}`; we dispatch it into the kernel and reply with the
				// result keyed by `id`. State changes flow back separately as pushes.
				const { id, type, params } = JSON.parse(
					typeof message === 'string' ? message : message.toString()
				)
				const kernel = await getKernel()
				try {
					const value = await kernel.dispatch(ws.data.id, { type, params })
					ws.send(JSON.stringify({ id, ok: true, value }))
				} catch (err) {
					const error = err instanceof Error ? err.message : String(err)
					ws.send(JSON.stringify({ id, ok: false, error }))
				}
				return
			}
			const text = typeof message === 'string' ? message : message.toString()
			// The launcher dispatches slash commands over /system (commands are a daemon
			// concept): parse, dispatch, and reply with what the launcher should show.
			const parsed = JSON.parse(text) as ClientMessage
			if (parsed.type === 'command') {
				const result = await dispatchCommand(parsed.name)
				send(ws, { type: 'commandResult', id: parsed.id, result })
				return
			}
			send(ws, { type: 'error', message: `Unknown command: ${text}` })
		},
		close(ws) {
			// App sockets are auto-unsubscribed from their topic by Bun on close; unpin the
			// reducer worker so it's reaped once idle. The agent socket is a plain subscriber
			// (also auto-unsubscribed), so nothing to tear down.
			if (ws.data.type === 'app') sandboxes.release(ws.data.id)
		}
	}
})

const port = server.port
if (port === undefined) throw new Error('quay daemon: server has no TCP port')
await writeRuntime({ port, token, pid: process.pid })
runtimeWritten = true

// Bind the notification sink now the server is up: an app's `notify` capability call
// and the agent's pings fan out to every launcher `/system` socket. A notification
// raised before this point (or with no launcher connected) is simply dropped — case-1
// notifications are transient (durable replay is a later phase).
setNotificationChannel((notification) =>
	server.publish(
		'notify',
		JSON.stringify({ type: 'notification', notification } satisfies ServerMessage)
	)
)

// Bind the agent broadcast sink: every turn publishes its transcript + busy/error to the
// `agent` topic, which each connected chat subscribes to. This is what makes the chat a
// live view of the shared session — a daemon-driven `/skill` turn surfaces without polling.
setAgentBroadcast((event) => server.publish('agent', JSON.stringify(event satisfies AgentEvent)))

// Project the kernel catalog into ~/Applications/Quay Apps/*.app so installed apps are
// real macOS apps (Spotlight/Launchpad), launchable with the launcher closed. One-way,
// the Volume wins; preview apps (app-code's transient live previews) stay out of the OS
// projection. Fire-and-forget: a projection failure must never take the daemon down —
// the in-app catalog and `/app/<id>` routes keep working regardless.
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
	await reconcileProjection(apps)
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

// Push the current catalog to every connected launcher (`/system` sockets). Called
// on connect and whenever the installed set changes.
async function refreshCatalog(): Promise<void> {
	const kernel = await getKernel()
	const apps = await kernel.list()
	server.publish('catalog', JSON.stringify({ type: 'apps', apps } satisfies ServerMessage))
}

// A catalog mutation (a devkit ship, an uninstall) fans out two ways: refresh every
// launcher's list and re-project the OS `.app` bundles. Coalesced so a burst
// collapses to a single pass and two reconciles never race the filesystem. Preview
// churn never reaches here — hidden ids raise no lifecycle event.
const reconcile = coalesce(async () => {
	await refreshCatalog()
	await project()
})

void project().catch((error) => console.error('quay daemon: projection failed', error))

// One kernel subscription drives both live-state fan-out and catalog reconcile: an
// app window subscribes to its `app:<id>` topic on connect (above) and Bun owns the
// socket set, while install/uninstall events trigger the coalesced `reconcile`.
getKernel().then((kernel) =>
	kernel.subscribe((event) => {
		if (event.type === 'app.update')
			server.publish(`app:${event.appId}`, JSON.stringify({ state: event.state }))
		else if (event.type === 'app.installed' || event.type === 'app.uninstalled') reconcile()
	})
)
