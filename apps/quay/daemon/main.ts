import type { Kernel } from '@justfiles/app'
import design from '@justfiles/design/design.css' with { type: 'text' }
import mac from '@justfiles/design/mac.css' with { type: 'text' }
import type { ServerWebSocket } from 'bun'
import { BunWebSocketTransport, RpcSession } from 'capnweb'
import { agentRpcTarget } from './agent'
import { getVolume } from './fs'
import { getKernel } from './kernel'
import type { ServerMessage } from './protocol'
// `type: 'text'` loads the raw HTML string (no Bun HTML bundling); inlined under `--compile`.
import testPage from './test.html' with { type: 'text' }

// Static imports so `bun build --compile` inlines the bytes into the executable;
// the map keys are the allowlist for the `/design/:name` route.
const styles: Record<string, string> = { 'design.css': design, 'mac.css': mac }

type WSContext = {
	id: string
	// Set for `/agent` sockets: the Cap'n Web transport this connection's RPC
	// session reads from. The shared handler feeds raw frames into it.
	transport?: BunWebSocketTransport<WSContext>
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
		'/agent': (req, server) => {
			if (server.upgrade(req, { data: { id: 'agent' } })) return undefined
			return new Response('Expected WebSocket upgrade', { status: 426 })
		},
		'/app/:id': () => new Response('Not Implemented', { status: 501 })
	},
	websocket: {
		data: {} as WSContext,

		async open(ws) {
			if (ws.data.id === 'agent') {
				// Stash the transport SYNCHRONOUSLY, before any await: the client sends
				// its first RPC frame the instant the socket opens, and `message` feeds
				// frames into `ws.data.transport`. If we awaited first, that frame would
				// hit an undefined transport and be dropped — desyncing the Cap'n Web
				// protocol and breaking the session. The transport buffers frames in its
				// receive queue until the session below starts reading them.
				const transport = new BunWebSocketTransport(ws)
				ws.data.transport = transport
				const fs = await getVolume()
				new RpcSession(transport, await agentRpcTarget(fs))
				return
			}

			if (ws.data.id === 'system') {
				const fs = await getVolume()
				ws.subscribe('catalog')
				kernel = await getKernel(fs)
				const apps = await kernel.list()
				server.publish('catalog', JSON.stringify({ type: 'apps', apps } satisfies ServerMessage))
			}
		},
		async message(ws, message) {
			if (ws.data.transport) {
				ws.data.transport.dispatchMessage(message)
				return
			}
			const text = typeof message === 'string' ? message : message.toString()
			send(ws, { type: 'error', message: `Unknown command: ${text}` })
		},
		close(ws, code, reason) {
			ws.data.transport?.dispatchClose(code, reason)
		}
	}
})
