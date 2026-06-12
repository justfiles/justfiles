// The localhost server quayd serves. Two transports share one port:
//
//   • http — assets for a mini-app window: the HTML shell (`/app/<id>`), its
//     `gui.js` read from the Volume (`/app/<id>/gui.js`), and the shared-React +
//     boot vendor modules (`/vendor/*`). 127.0.0.1 is a secure context, so the
//     importmap + ES modules in the shell work.
//   • ws  — `/` is the launcher's JSON request/response (the catalog, a debug ls,
//     and the agent chat); `/berth?app=<id>` is a token-scoped Cap'n Web session
//     (§berth.ts) for a GUI.
//
// Every connection and the shell route present the boot token.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { type RawData, WebSocket, WebSocketServer } from 'ws'
import type { AgentMessage } from './agent.ts'
import { designAsset, shellHtml, vendorAssets } from './assets.ts'
import { type BerthBackend, serveBerth } from './berth.ts'

export interface AppInfo {
	id: string
	name: string
	glyph: string
}

// The launcher's agent channel (Slice 10): non-streaming request/response. The UI
// echoes the user turn optimistically and waits for the authoritative transcript.
export interface AgentBridge {
	history(): AgentMessage[]
	prompt(text: string): Promise<AgentMessage[]>
	abort(): void
}

export interface Backend extends BerthBackend {
	list(): Promise<AppInfo[]>
	// Debug (Slice 5 verify): a directory listing of the Volume at `path`.
	ls(path: string): Promise<unknown>
	// The app's `gui.js` bytes, read from the Volume — the materialised `.app`s
	// carry no code.
	gui(id: string): Promise<Uint8Array>
	// Optional so tests can serve a backend with no agent (the catalog still works).
	agent?: AgentBridge
}

export interface Served {
	port: number
	// Push the current `kernel.list()` to every connected launcher socket. The daemon
	// calls this after an install (Slice 11) so an open launcher re-lists live.
	broadcastCatalog(): Promise<void>
	close(): void
}

// Idle-exit window: with no clients connected (launcher socket + open app berths),
// quayd shuts down; a client re-spawns it on demand.
const IDLE_MS = 5 * 60_000

export function serve(
	backend: Backend,
	// `windows` (when wired) is told a GUI window opened/closed for an app, so the
	// sandbox pool can pin/evict its reducer worker (§nodeSandbox, Slice 8).
	opts: {
		token: string
		onIdle?: () => void
		windows?: { open(appId: string): void; close(appId: string): void }
	}
): Promise<Served> {
	const http = createServer((req, res) => {
		serveHttp(req, res, backend).catch(() => fail(res, 500))
	})
	const wss = new WebSocketServer({ server: http })
	const clients = new Set<WebSocket>()
	// The launcher's privileged JSON sockets, tracked apart from berths (which speak
	// Cap'n Web, not JSON) so a catalog push reaches only them.
	const launchers = new Set<WebSocket>()
	let idle: ReturnType<typeof setTimeout> | undefined

	const arm = () => {
		if (idle) {
			clearTimeout(idle)
			idle = undefined
		}
		if (clients.size === 0 && opts.onIdle) idle = setTimeout(opts.onIdle, IDLE_MS)
	}

	wss.on('connection', (ws, req) => {
		const url = new URL(req.url ?? '/', 'ws://127.0.0.1')
		if (url.searchParams.get('token') !== opts.token) {
			ws.close()
			return
		}
		clients.add(ws)
		arm()
		ws.on('close', () => {
			clients.delete(ws)
			arm()
		})
		// A GUI window's berth: a Cap'n Web session scoped to one app. Opening it
		// pins the app's reducer worker; closing it starts the idle countdown.
		if (url.pathname === '/berth') {
			const appId = url.searchParams.get('app')
			if (!appId) {
				ws.close()
				return
			}
			opts.windows?.open(appId)
			ws.on('close', () => opts.windows?.close(appId))
			serveBerth(ws, backend, appId)
			return
		}
		// The launcher's privileged JSON socket (catalog + debug ls + agent chat).
		launchers.add(ws)
		ws.on('close', () => launchers.delete(ws))
		ws.on('message', (data: RawData) => {
			respond(ws, backend, data).catch((error) =>
				reply(ws, { type: 'error', error: String(error) })
			)
		})
	})

	const broadcastCatalog = async (): Promise<void> => {
		const payload = { type: 'catalog', apps: await backend.list() }
		for (const ws of launchers) reply(ws, payload)
	}

	return new Promise((resolve) => {
		http.listen(0, '127.0.0.1', () => {
			const addr = http.address()
			const port = addr && typeof addr === 'object' ? addr.port : 0
			arm()
			resolve({
				port,
				broadcastCatalog,
				close: () => {
					wss.close()
					http.close()
				}
			})
		})
	})
}

async function serveHttp(
	req: IncomingMessage,
	res: ServerResponse,
	backend: Backend
): Promise<void> {
	const url = new URL(req.url ?? '/', 'http://127.0.0.1')
	const path = url.pathname

	if (path.startsWith('/vendor/')) {
		const bytes = (await vendorAssets()).get(path)
		return bytes ? send(res, 'text/javascript', bytes) : fail(res, 404)
	}

	const design = /^\/design\/([a-z][a-z0-9-]*\.css)$/.exec(path)
	if (design) {
		try {
			return send(res, 'text/css; charset=utf-8', await designAsset(design[1] as string))
		} catch {
			return fail(res, 404)
		}
	}

	const gui = /^\/app\/([^/]+)\/gui\.js$/.exec(path)
	if (gui) {
		try {
			const bytes = await backend.gui(decodeURIComponent(gui[1] as string))
			// no-store so app-code's preview iframe re-fetches fresh gui.js on each
			// re-run (the draft is reinstalled under the same `preview.<slug>` id).
			res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' })
			res.end(Buffer.from(bytes))
			return
		} catch {
			return fail(res, 404)
		}
	}

	const shell = /^\/app\/([^/]+)\/?$/.exec(path)
	if (shell) {
		const id = decodeURIComponent(shell[1] as string)
		const html = shellHtml(id, url.searchParams.get('token') ?? '', await usesReact(backend, id))
		return send(res, 'text/html; charset=utf-8', new TextEncoder().encode(html))
	}

	fail(res, 404)
}

// Whether an app's gui.js imports React, so the shell preloads the React core only
// when it's used. Bundled guis emit bare `"react"`/`"react-dom"`/`"react/…"` specifiers
// (resolved via the shell's importmap); a pure-DOM gui has none. A false positive only
// costs an unused preload, so a cheap substring scan is enough.
async function usesReact(backend: Backend, id: string): Promise<boolean> {
	try {
		const text = new TextDecoder().decode(await backend.gui(id))
		return text.includes('"react') || text.includes("'react")
	} catch {
		return false
	}
}

function send(res: ServerResponse, type: string, bytes: Uint8Array): void {
	res.writeHead(200, { 'content-type': type })
	res.end(Buffer.from(bytes))
}

function fail(res: ServerResponse, code: number): void {
	res.writeHead(code)
	res.end()
}

async function respond(ws: WebSocket, backend: Backend, data: RawData): Promise<void> {
	let msg: { type?: string; path?: string; text?: string }
	try {
		msg = JSON.parse(data.toString())
	} catch {
		return
	}
	if (msg.type === 'list') reply(ws, { type: 'catalog', apps: await backend.list() })
	else if (msg.type === 'ls') reply(ws, { type: 'ls', entries: await backend.ls(msg.path ?? '/') })
	else if (msg.type === 'agent.history' && backend.agent)
		reply(ws, { type: 'agent', messages: backend.agent.history() })
	else if (msg.type === 'prompt' && backend.agent)
		reply(ws, { type: 'agent', messages: await backend.agent.prompt(msg.text ?? '') })
	else if (msg.type === 'abort') backend.agent?.abort()
}

function reply(ws: WebSocket, payload: unknown): void {
	if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload))
}
