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
import { IDLE_MS, idle, serve } from './daemon.ts'
import { socketPath } from './paths.ts'
import type { Reply, Request } from './protocol.ts'

describe('idle', () => {
	const now = 1_000_000_000

	it('is idle with no client, nothing running and no wake', () => {
		expect(idle(0, { busy: false }, now)).toBe(true)
	})

	it('is not idle while a client is connected or an input is answered', () => {
		expect(idle(1, { busy: false }, now)).toBe(false)
		expect(idle(0, { busy: true }, now)).toBe(false)
	})

	it('is not idle when a wake is due within a few minutes', () => {
		expect(idle(0, { busy: false, nextWakeAt: now + 60_000 }, now)).toBe(false)
		expect(idle(0, { busy: false, nextWakeAt: now - 1 }, now)).toBe(false)
		expect(idle(0, { busy: false, nextWakeAt: now + IDLE_MS + 60 * 60_000 }, now)).toBe(true)
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
