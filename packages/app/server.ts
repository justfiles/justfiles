// Minimal Bun harness for iterating on an app locally. Pairs with the
// browser-side bridge (`@justfiles/app/client`); the author imports both and
// never touches transport code.
//
// State is in-memory by design — persistence is out of scope for the dev kit.

import type { HTMLBundle, Server, ServerWebSocket } from 'bun'
import type { AnyApp } from './app.js'
import type { Action, Actor } from './engine.js'
import {
	dispatch,
	briefing as getBriefing,
	initial as getInitial,
	view as getView
} from './runtime.js'

type SocketData = Record<string, never>

export interface ServeAppOptions {
	app: AnyApp
	html: HTMLBundle
	port?: number
	actor?: Actor
}

interface Frame {
	jsonrpc?: string
	id?: string
	method?: string
	params?: { action?: Action }
}

export function serveApp(opts: ServeAppOptions): Server<SocketData> {
	const actor: Actor = opts.actor ?? { id: 'user', kind: 'human' }
	let state = getInitial(opts.app)
	const sockets = new Set<ServerWebSocket<SocketData>>()

	const broadcastState = (newState: unknown) => {
		const note = JSON.stringify({
			jsonrpc: '2.0',
			method: 'app.state',
			params: { state: newState }
		})
		for (const s of sockets) s.send(note)
	}

	return Bun.serve<SocketData, '/__app' | '/*'>({
		port: opts.port,
		routes: {
			'/__app': (req: Request, server: Server<SocketData>) => {
				if (server.upgrade(req, { data: {} })) return
				return new Response('Expected websocket', { status: 426 })
			},
			'/*': opts.html
		},
		websocket: {
			open(ws) {
				sockets.add(ws)
			},
			close(ws) {
				sockets.delete(ws)
			},
			message(ws, raw) {
				let msg: Frame
				try {
					msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw))
				} catch {
					return
				}
				if (msg.method === 'app.ready') {
					ws.send(
						JSON.stringify({
							jsonrpc: '2.0',
							id: msg.id,
							result: {
								state: getView(opts.app, state, actor),
								briefing: getBriefing(opts.app)
							}
						})
					)
					return
				}
				if (msg.method === 'app.action' && msg.params?.action) {
					const result = dispatch(opts.app, state, msg.params.action, actor)
					if (result.ok) state = result.next
					ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
					if (result.ok) broadcastState(result.view)
				}
			}
		},
		development: process.env.NODE_ENV !== 'production' && { hmr: true, console: true }
	})
}
