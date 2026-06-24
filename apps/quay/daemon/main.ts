import type { Kernel } from '@justfiles/app'
import design from '@justfiles/design/design.css' with { type: 'text' }
import mac from '@justfiles/design/mac.css' with { type: 'text' }
import type { ServerWebSocket } from 'bun'
import { getKernel } from './kernel'
import type { ServerMessage } from './protocol'
// `type: 'text'` loads the raw HTML string (no Bun HTML bundling); inlined under `--compile`.
import testPage from './test.html' with { type: 'text' }

// Static imports so `bun build --compile` inlines the bytes into the executable;
// the map keys are the allowlist for the `/design/:name` route.
const styles: Record<string, string> = { 'design.css': design, 'mac.css': mac }

type WSContext = {
	id: string
}

// Single typed exit point for client-bound messages; routing every send through
// the `ServerMessage` union is what makes the wire protocol checked at compile time.
const send = (ws: ServerWebSocket<WSContext>, message: ServerMessage) =>
	ws.send(JSON.stringify(message))

let kernel: Kernel | undefined

const server = Bun.serve({
	routes: {
		'/': () =>
			new Response(testPage, {
				headers: { 'content-type': 'text/html; charset=utf-8' }
			}),
		'/design/:name': (req) => {
			const body = styles[req.params.name]
			if (!body) return new Response('Not Found', { status: 404 })
			return new Response(body, {
				headers: { 'content-type': 'text/css; charset=utf-8' }
			})
		},
		'/system': (req, server) => {
			// Upgrade to a WebSocket; Bun replies with 101 on success.
			if (server.upgrade(req, { data: { id: 'system' } })) return undefined
			return new Response('Expected WebSocket upgrade', { status: 426 })
		},
		'/agent': () => new Response('Not Implemented', { status: 501 }),
		'/app/:id': () => new Response('Not Implemented', { status: 501 })
	},
	websocket: {
		data: {} as WSContext,

		async open(ws) {
			if (ws.data.id === 'system') {
				ws.subscribe('catalog')
				kernel = await getKernel()
				const apps = await kernel.list()
				server.publish('catalog', JSON.stringify({ type: 'apps', apps } satisfies ServerMessage))
			}
		},
		async message(ws, message) {
			const text = typeof message === 'string' ? message : message.toString()
			const id = ws.data.id
			if (id === 'system') {
				if (text === '/hello') {
					send(ws, {
						type: 'hello',
						message: 'hello world',
						time: new Date().toISOString(),
						uptime: process.uptime()
					})
					return
				}
			}
			send(ws, { type: 'error', message: `Unknown command: ${text}` })
		}
	}
})
