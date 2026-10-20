import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { join } from 'node:path'
import { socketPath } from './paths.ts'
import { decoder, encode, type Reply, type Request } from './protocol.ts'

/** The connection ended before the exchange did. */
export class Lost extends Error {
	constructor() {
		super('lost the connection to the daemon')
	}
}

/**
 * Send `request` (none: only listen) over `socket` and hand every reply to `onReply` until
 * it returns true, then close. Rejects with `Lost` when the daemon goes away first.
 */
export function exchange(
	socket: Socket,
	request: Request | undefined,
	onReply: (reply: Reply) => boolean
): Promise<void> {
	return new Promise((resolve, reject) => {
		let finished = false
		socket.setEncoding('utf8')
		socket.on(
			'data',
			decoder((message) => {
				if (finished || !onReply(message as Reply)) return
				finished = true
				socket.end()
				resolve()
			})
		)
		socket.on('error', () => {})
		socket.on('close', () => {
			if (!finished) reject(new Lost())
		})
		if (request !== undefined) socket.write(encode(request))
	})
}

/** Connect to the daemon in `dir`; when nothing answers, start it and retry. */
export async function connectOrStart(dir: string): Promise<Socket> {
	const first = await connect(socketPath(dir))
	if (first !== undefined) return first
	start(dir)
	const deadline = Date.now() + 30_000
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 100))
		const socket = await connect(socketPath(dir))
		if (socket !== undefined) return socket
	}
	throw new Error(`the daemon did not start; see ${join(dir, 'serve.log')}`)
}

export function connect(path: string): Promise<Socket | undefined> {
	return new Promise((resolve) => {
		const socket = createConnection(path)
		socket.once('connect', () => resolve(socket))
		socket.once('error', () => resolve(undefined))
	})
}

/** `ghost serve`, detached from this process, logging into the shell directory. */
function start(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 })
	const log = openSync(join(dir, 'serve.log'), 'a')
	spawn(process.execPath, [...process.execArgv, process.argv[1], 'serve'], {
		detached: true,
		stdio: ['ignore', log, log]
	}).unref()
	closeSync(log)
}
