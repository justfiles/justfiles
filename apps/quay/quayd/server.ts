// The localhost socket quayd serves. Slice 4 carries a tiny JSON request/response
// for the stub catalog; Slice 6 replaces it with token-scoped Cap'n Web berths
// (and http-served assets). Every connection must present the boot token.

import { createServer } from 'node:http'
import { type RawData, type WebSocket, WebSocketServer } from 'ws'

export interface AppInfo {
	id: string
	name: string
	glyph: string
}

export interface Backend {
	list(): AppInfo[]
}

export interface Served {
	port: number
	close(): void
}

// Idle-exit window: with no clients connected, quayd shuts down (the launcher
// re-spawns it on demand). The launcher holds a connection for as long as it runs.
const IDLE_MS = 5 * 60_000

export function serve(
	backend: Backend,
	opts: { token: string; onIdle?: () => void }
): Promise<Served> {
	const http = createServer()
	const wss = new WebSocketServer({ server: http })
	const clients = new Set<WebSocket>()
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
		ws.on('message', (data: RawData) => {
			let msg: { type?: string }
			try {
				msg = JSON.parse(data.toString())
			} catch {
				return
			}
			if (msg.type === 'list') {
				ws.send(JSON.stringify({ type: 'catalog', apps: backend.list() }))
			}
		})
		ws.on('close', () => {
			clients.delete(ws)
			arm()
		})
	})

	return new Promise((resolve) => {
		http.listen(0, '127.0.0.1', () => {
			const addr = http.address()
			const port = addr && typeof addr === 'object' ? addr.port : 0
			arm()
			resolve({
				port,
				close: () => {
					wss.close()
					http.close()
				}
			})
		})
	})
}
