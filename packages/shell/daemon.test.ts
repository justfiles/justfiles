import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai'
import { volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { openGhost } from '@justfiles/ghost'
import { openNodeSqliteState } from '@justfiles/ghost/state/node-sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connect, exchange } from './client.ts'
import { idle, serve } from './daemon.ts'
import { socketPath } from './paths.ts'
import type { Reply, Request } from './protocol.ts'

describe('idle', () => {
	it('is idle with no client and nothing running', () => {
		expect(idle(0, { busy: false })).toBe(true)
		expect(idle(0, { busy: false, consolidation: { from: '2026-10-20', running: false } })).toBe(
			true
		)
	})

	it('is not idle while a client is connected or an input is answered', () => {
		expect(idle(1, { busy: false })).toBe(false)
		expect(idle(0, { busy: true })).toBe(false)
	})

	it('is not idle while a consolidation runs', () => {
		expect(idle(0, { busy: false, consolidation: { from: '2026-10-20', running: true } })).toBe(
			false
		)
	})
})

describe('serve', () => {
	let dir: string
	let faux: ReturnType<typeof fauxProvider>

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'shell-'))
		faux = fauxProvider()
	})

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	async function ghost() {
		const models = createModels()
		models.setProvider(faux.provider)
		return openGhost({
			volume: volume(memStore()),
			state: await openNodeSqliteState(':memory:'),
			models,
			shell: { id: 'test', name: 'Test', kind: 'test' },
			settings: { model: { provider: 'faux', modelId: 'faux-1' } }
		})
	}

	it('streams the transcript, settles an ask, and exits once idle', async () => {
		faux.setResponses([fauxAssistantMessage('Paris')])
		let closed = false
		const served = serve(await ghost(), socketPath(dir), { idleMs: 50 }).then(() => {
			closed = true
		})

		const replies: Reply[] = []
		await exchange(
			await connected(dir),
			{ type: 'ask', id: 'q1', text: 'Capital of France?', cwd: '/' },
			(reply) => {
				replies.push(reply)
				return reply.type === 'settled'
			}
		)

		expect(replies[0]?.type).toBe('snapshot')
		expect(replies.at(-1)).toEqual({ type: 'settled', id: 'q1', status: 'done', text: 'Paris' })
		expect(replies.some((reply) => reply.type === 'text')).toBe(true)
		await served
		expect(closed).toBe(true)
	})

	it('answers status, abort and new, and stays up while a client is connected', async () => {
		const stop = new AbortController()
		const served = serve(await ghost(), socketPath(dir), { idleMs: 20, signal: stop.signal })

		const replies: Reply[] = []
		const watching = exchange(await connected(dir), undefined, (reply) => {
			replies.push(reply)
			return false
		}).catch(() => {})
		await new Promise((resolve) => setTimeout(resolve, 100))
		const status = await one(dir, { type: 'status' }, 'status')
		expect(status).toMatchObject({ type: 'status', status: { busy: false, queued: 0 } })
		expect(await one(dir, { type: 'abort' }, 'done')).toEqual({ type: 'done', request: 'abort' })
		expect(await one(dir, { type: 'new', handoff: 'next' }, 'done')).toEqual({
			type: 'done',
			request: 'new'
		})

		expect(replies[0]?.type).toBe('snapshot')
		stop.abort()
		await served
		await watching
	})

	it('answers a quick to its client alone', async () => {
		const stop = new AbortController()
		const asked: Request[] = []
		const served = serve(await ghost(), socketPath(dir), {
			signal: stop.signal,
			quick: async (request) => {
				asked.push(request)
				return `${request.system}: ${request.text}`
			}
		})

		const replies: Reply[] = []
		const watching = exchange(await connected(dir), undefined, (reply) => {
			replies.push(reply)
			return false
		}).catch(() => {})
		const request: Request = { type: 'quick', text: 'apple', system: 'Explain', effort: 'low' }
		expect(await one(dir, request, 'quick')).toEqual({ type: 'quick', text: 'Explain: apple' })
		expect(asked).toEqual([request])
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(replies.map((reply) => reply.type)).toEqual(['snapshot'])

		stop.abort()
		await served
		await watching
	})

	it('relays a login and restarts when it asks to', async () => {
		const logins: boolean[] = []
		const served = serve(await ghost(), socketPath(dir), {
			login: async (device, notify) => {
				logins.push(device)
				notify({ type: 'auth_url', url: 'https://example.test/authorize' })
				return device
			}
		})

		const replies: Reply[] = []
		const login = (request: Request) =>
			connected(dir).then((socket) =>
				exchange(socket, request, (reply) => {
					if (reply.type === 'auth' || reply.type === 'done') replies.push(reply)
					return reply.type === 'done'
				})
			)
		await login({ type: 'login' })
		await login({ type: 'login', device: true })

		expect(logins).toEqual([false, true])
		expect(replies).toEqual([
			{ type: 'auth', event: { type: 'auth_url', url: 'https://example.test/authorize' } },
			{ type: 'done', request: 'login' },
			{ type: 'auth', event: { type: 'auth_url', url: 'https://example.test/authorize' } },
			{ type: 'done', request: 'login' }
		])
		await served
	})

	it('aborts a login when its client leaves', async () => {
		const stop = new AbortController()
		let aborted: () => void = () => {}
		const left = new Promise<void>((resolve) => {
			aborted = resolve
		})
		const served = serve(await ghost(), socketPath(dir), {
			signal: stop.signal,
			login: (_device, notify, signal) => {
				signal.addEventListener('abort', aborted)
				notify({ type: 'progress', message: 'waiting' })
				return new Promise(() => {})
			}
		})

		const socket = await connected(dir)
		await exchange(socket, { type: 'login' }, (reply) => reply.type === 'auth')
		await left
		stop.abort()
		await served
	})

	it('reports consolidation in status, and exits idle while it waits', async () => {
		const stop = new AbortController()
		let closed = false
		const served = serve(await ghost(), socketPath(dir), {
			idleMs: 20,
			signal: stop.signal
		}).then(() => {
			closed = true
		})

		const status = await one(dir, { type: 'status' }, 'status')
		await new Promise((resolve) => setTimeout(resolve, 100))

		expect(status).toMatchObject({
			status: { consolidation: { from: new Date().toISOString().slice(0, 10), running: false } }
		})
		expect(closed).toBe(true)
		stop.abort()
		await served
	})
})

async function one(dir: string, request: Request, type: Reply['type']) {
	let got: Reply | undefined
	await exchange(await connected(dir), request, (reply) => {
		if (reply.type !== type && reply.type !== 'error') return false
		got = reply
		return true
	})
	return got
}

/** A connection to the daemon in `dir`, once it listens. */
async function connected(dir: string) {
	for (;;) {
		const socket = await connect(socketPath(dir))
		if (socket !== undefined) return socket
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
}
