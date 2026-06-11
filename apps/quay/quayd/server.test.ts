import { afterAll, beforeAll, expect, test } from 'vitest'
import { WebSocket } from 'ws'
import { type Served, serve } from './server.ts'

const apps = [{ id: 'code', name: 'Code', glyph: 'C' }]
const entries = [{ name: 'applications' }, { name: 'state' }]
let served: Served

beforeAll(async () => {
	served = await serve({ list: async () => apps, ls: async () => entries }, { token: 'secret' })
})
afterAll(() => served.close())

function open(token: string): Promise<WebSocket> {
	const ws = new WebSocket(`ws://127.0.0.1:${served.port}/?token=${token}`)
	return new Promise((resolve, reject) => {
		ws.once('open', () => resolve(ws))
		ws.once('error', reject)
	})
}

function request(ws: WebSocket, message: unknown): Promise<unknown> {
	const reply = new Promise((resolve) =>
		ws.once('message', (data) => resolve(JSON.parse(data.toString())))
	)
	ws.send(JSON.stringify(message))
	return reply
}

test('serves the catalog to a client with the right token', async () => {
	const ws = await open('secret')
	expect(await request(ws, { type: 'list' })).toEqual({ type: 'catalog', apps })
	ws.close()
})

test('serves a Volume directory listing for a debug ls', async () => {
	const ws = await open('secret')
	expect(await request(ws, { type: 'ls', path: '/' })).toEqual({ type: 'ls', entries })
	ws.close()
})

test('rejects a client with the wrong token', async () => {
	const ws = new WebSocket(`ws://127.0.0.1:${served.port}/?token=wrong`)
	const code = await new Promise((resolve) => ws.once('close', resolve))
	expect(code).toBeGreaterThanOrEqual(1000)
})
