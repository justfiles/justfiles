// Minimal Bun harness for iterating on an app locally. Pairs with the
// browser-side bridge (`@justfiles/app/client`); the author imports both and
// never touches transport code.
//
// State is in-memory by design — persistence is out of scope for the dev kit.

import type { HTMLBundle, Server, ServerWebSocket } from 'bun'
import type { AnyApp } from './app.js'
import type { Action, Actor } from './engine.js'
import { Runner } from './runner.js'
import type { TaskMeta } from './tasks.js'

type SocketData = Record<string, never>

export interface ServeAppOptions {
	app: AnyApp
	html: HTMLBundle
	port?: number
	actor?: Actor
	/**
	 * Optional task host context factory. The Bun harness has no broker, so
	 * authors typically pass fakes here for local iteration. `meta` carries
	 * the active task id, run id, and state if the fake needs to branch on
	 * which task is running.
	 */
	taskHost?: (meta: TaskMeta) => Record<string, unknown>
}

interface Frame {
	jsonrpc?: string
	id?: string
	method?: string
	params?: { action?: Action }
}

export function serveApp(opts: ServeAppOptions): Server<SocketData> {
	const actor: Actor = opts.actor ?? { id: 'user', kind: 'human' }
	const sockets = new Set<ServerWebSocket<SocketData>>()

	const broadcastState = (newState: unknown) => {
		const note = JSON.stringify({
			jsonrpc: '2.0',
			method: 'app.state',
			params: { state: newState }
		})
		for (const s of sockets) s.send(note)
	}

	const runner = new Runner({
		app: opts.app,
		host: opts.taskHost,
		onChange: () => broadcastState(runner.view(actor))
	})
	const ready = runner.start()

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
			async message(ws, raw) {
				let msg: Frame
				try {
					msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw))
				} catch {
					return
				}
				await ready
				if (msg.method === 'app.ready') {
					ws.send(
						JSON.stringify({
							jsonrpc: '2.0',
							id: msg.id,
							result: {
								state: runner.view(actor),
								briefing: runner.briefing()
							}
						})
					)
					return
				}
				if (msg.method === 'app.action' && msg.params?.action) {
					const result = await runner.dispatch(msg.params.action, actor)
					ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
				}
			}
		},
		development: process.env.NODE_ENV !== 'production' && { hmr: true, console: true }
	})
}
