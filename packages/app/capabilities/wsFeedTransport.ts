// A pull-based `RpcTransport` for the Cloudflare Durable Object hibernation model.
// The runtime has no live message callback — frames arrive via `webSocketMessage`
// — so this transport exposes a `feed` the message handler pushes raw frames into,
// and `receive()` pulls them in order. `send` goes straight to the socket; `abort`
// (on close) rejects a pending receive so the session winds down cleanly.

import type { RpcTransport } from 'capnweb'

// The socket surface this transport needs: send frames, and (optionally) close —
// so a transport abort tears the socket down and the peer sees the disconnect.
interface Socket {
	send(data: string): void
	close?(): void
}

export function wsFeedTransport(ws: Socket): {
	transport: RpcTransport
	feed: (frame: string) => void
} {
	const msgs: string[] = []
	const waiters: Array<{ resolve: (m: string) => void; reject: (e: unknown) => void }> = []
	let failed: unknown
	let aborted = false

	const transport: RpcTransport = {
		send: async (message) => ws.send(message),
		receive: () =>
			new Promise<string>((resolve, reject) => {
				const msg = msgs.shift()
				if (msg !== undefined) resolve(msg)
				else if (aborted) reject(failed)
				else waiters.push({ resolve, reject })
			}),
		// Idempotent: reject any pending receive so the session winds down, then
		// close the socket so the peer reconnects. Cap'n Web calls this on its own
		// errors; the socket's close handler routes here too.
		abort: (reason) => {
			if (aborted) return
			aborted = true
			failed = reason ?? new Error('aborted')
			for (const w of waiters) w.reject(failed)
			waiters.length = 0
			ws.close?.()
		}
	}

	const feed = (frame: string): void => {
		const w = waiters.shift()
		if (w) w.resolve(frame)
		else msgs.push(frame)
	}

	return { transport, feed }
}
