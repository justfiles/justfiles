import { rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import type { AuthEvent } from '@earendil-works/pi-ai'
import type { Ghost, GhostStatus } from '@justfiles/ghost'
import { asRequest, decoder, encode, type Reply, type Request } from './protocol.ts'

/** How long the daemon stays up with nothing to do. */
export const IDLE_MS = 5 * 60_000

/**
 * May the daemon exit: no client connected, no input being answered, and no wake pending.
 * Nothing starts the daemon for a wake, so one that is pending keeps it up, however far off:
 * the consolidating shell's daemon stays up from one night to the next.
 */
export function idle(clients: number, status: Pick<GhostStatus, 'busy' | 'nextWakeAt'>): boolean {
	return clients === 0 && !status.busy && status.nextWakeAt === undefined
}

/**
 * The shell's own sign-in, run for a `login` request. `signal` aborts when the client
 * leaves. Resolves true when the daemon has to restart to use the new credential.
 */
export type Login = (
	device: boolean,
	notify: (event: AuthEvent) => void,
	signal: AbortSignal
) => Promise<boolean>

/**
 * Serve `ghost` on the Unix socket at `path` until it has stayed idle for `idleMs`,
 * `signal` aborts or a login asks for a restart, then close the ghost. Resolves once it
 * is closed.
 */
export async function serve(
	ghost: Ghost,
	path: string,
	opts: { idleMs?: number; signal?: AbortSignal; login?: Login } = {}
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
		if (!closing && status !== undefined && idle(clients.size, status))
			timer = setTimeout(stop, idleMs)
	}
	const unwatch = ghost.watch((event) => {
		if (event.type !== 'snapshot' && event.type !== 'status') return
		status = event.status
		check()
	})

	async function handle(request: Request, send: (reply: Reply) => void, left: AbortSignal) {
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
				return
			case 'login': {
				if (opts.login === undefined) throw new Error('login is not available')
				const notify = (event: AuthEvent) => send({ type: 'auth', event })
				const restart = await opts.login(request.device === true, notify, left)
				send({ type: 'done', request: 'login' })
				if (restart) stop()
			}
		}
	}

	const server = createServer((socket) => {
		clients.add(socket)
		check()
		const send = (reply: Reply) => {
			if (!socket.destroyed) socket.write(encode(reply))
		}
		const unsubscribe = ghost.watch(send)
		const left = new AbortController()
		socket.setEncoding('utf8')
		socket.on(
			'data',
			decoder(
				(message) => {
					const request = asRequest(message)
					if (request === undefined) return send({ type: 'error', message: 'not a request' })
					handle(request, send, left.signal).catch((error: unknown) =>
						send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
					)
				},
				() => send({ type: 'error', message: 'not JSON' })
			)
		)
		// A client that vanishes mid-write is the same as one that left.
		socket.on('error', () => {})
		socket.on('close', () => {
			left.abort()
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
