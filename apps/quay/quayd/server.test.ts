import { afterAll, beforeAll, expect, test } from 'vitest'
import { WebSocket } from 'ws'
import { type Served, serve } from './server.ts'

const apps = [{ id: 'code', name: 'Code', glyph: 'C' }]
let served: Served

beforeAll(async () => {
	served = await serve({ list: () => apps }, { token: 'secret' })
})
afterAll(() => served.close())

function open(token: string): Promise<WebSocket> {
	const ws = new WebSocket(`ws://127.0.0.1:${served.port}/?token=${token}`)
	return new Promise((resolve, reject) => {
		ws.once('open', () => resolve(ws))
		ws.once('error', reject)
	})
}

test('serves the catalog to a client with the right token', async () => {
	const ws = await open('secret')
	const catalog = new Promise((resolve) =>
		ws.once('message', (data) => resolve(JSON.parse(data.toString())))
	)
	ws.send(JSON.stringify({ type: 'list' }))
	expect(await catalog).toEqual({ type: 'catalog', apps })
	ws.close()
})

test('rejects a client with the wrong token', async () => {
	const ws = new WebSocket(`ws://127.0.0.1:${served.port}/?token=wrong`)
	const code = await new Promise((resolve) => ws.once('close', resolve))
	expect(code).toBeGreaterThanOrEqual(1000)
})
