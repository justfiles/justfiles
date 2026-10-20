import { rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import type { Ghost, GhostStatus } from '@justfiles/ghost'
import { asRequest, decoder, encode, type Reply, type Request } from './protocol.ts'

/** How long the daemon stays up with nothing to do. */
export const IDLE_MS = 5 * 60_000
/** A wake this close keeps the daemon up. */
const WAKE_MARGIN_MS = 5 * 60_000

/**
 * May the daemon exit: no client connected, no input being answered, and no wake due soon.
 * `nextWakeAt` (epoch ms) counts once the ghost reports one; it reports none yet.
 */
export function idle(
	clients: number,
	status: Pick<GhostStatus, 'busy'> & { nextWakeAt?: number },
	now: number
): boolean {
	if (clients > 0 || status.busy) return false
	return status.nextWakeAt === undefined || status.nextWakeAt - now > WAKE_MARGIN_MS
}

/**
 * Serve `ghost` on the Unix socket at `path` until it has stayed idle for `idleMs` or
 * `signal` aborts, then close the ghost. Resolves once it is closed.
 */
export async function serve(
	ghost: Ghost,
	path: string,
	opts: { idleMs?: number; signal?: AbortSignal } = {}
): Promise<void> {
	const idleMs = opts.idleMs ?? IDLE_MS
	const clients = new Set<Socket>()
	let status: GhostStatus | undefined
	let timer: ReturnType<typeof setTimeout> | undefined
	let closing = false
	let stop = () => {}
	const stopped = new Promise<void>((resolve) => {
		stop = resolve
	})

	// Re-armed on every change, so the daemon exits only after `idleMs` of nothing.
	const check = () => {
		clearTimeout(timer)
		if (!closing && status !== undefined && idle(clients.size, status, Date.now()))
			timer = setTimeout(stop, idleMs)
	}
	const unwatch = ghost.watch((event) => {
		if (event.type !== 'snapshot' && event.type !== 'status') return
		status = event.status
		check()
	})

	async function handle(request: Request, send: (reply: Reply) => void) {
		switch (request.type) {
			case 'ask': {
				const { id, text, cwd, steer } = request
				const settled = await ghost.ask(text, { id, cwd, whenBusy: steer ? 'steer' : 'queue' })
				return send({ type: 'settled', ...settled })
			}
			case 'abort':
				await ghost.abort()
				return send({ type: 'done', request: 'abort' })
			case 'new':
				await ghost.newSession(request.handoff)
				return send({ type: 'done', request: 'new' })
			case 'status':
				if (status !== undefined) send({ type: 'status', status })
		}
	}

	const server = createServer((socket) => {
		clients.add(socket)
		check()
		const send = (reply: Reply) => {
			if (!socket.destroyed) socket.write(encode(reply))
		}
		const unsubscribe = ghost.watch(send)
		socket.setEncoding('utf8')
		socket.on(
			'data',
			decoder(
				(message) => {
					const request = asRequest(message)
					if (request === undefined) return send({ type: 'error', message: 'not a request' })
					handle(request, send).catch((error: unknown) =>
						send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
					)
				},
				() => send({ type: 'error', message: 'not JSON' })
			)
		)
		// A client that vanishes mid-write is the same as one that left.
		socket.on('error', () => {})
		socket.on('close', () => {
			unsubscribe()
			clients.delete(socket)
			check()
		})
	})

	// The caller holds the lock, so a socket file here is a dead daemon's.
	await rm(path, { force: true })
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(path, resolve)
	})
	opts.signal?.addEventListener('abort', () => stop())
	if (opts.signal?.aborted) stop()
	await stopped

	closing = true
	clearTimeout(timer)
	unwatch()
	const closed = new Promise((resolve) => server.close(resolve))
	for (const socket of clients) socket.destroy()
	await closed
	await ghost.close()
	await rm(path, { force: true })
}
