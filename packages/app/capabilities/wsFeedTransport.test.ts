import { expect, test } from 'vitest'
import { wsFeedTransport } from './wsFeedTransport.ts'

function fakeWs() {
	const sent: string[] = []
	return { sent, send: (d: string) => void sent.push(d) }
}

test('feed delivers frames to receive in order', async () => {
	const { transport, feed } = wsFeedTransport(fakeWs())
	feed('a')
	feed('b')
	feed('c')
	expect(await transport.receive()).toBe('a')
	expect(await transport.receive()).toBe('b')
	expect(await transport.receive()).toBe('c')
})

test('receive pends until the next feed', async () => {
	const { transport, feed } = wsFeedTransport(fakeWs())
	const p = transport.receive()
	let resolved = false
	void p.then(() => {
		resolved = true
	})
	await Promise.resolve()
	expect(resolved).toBe(false)
	feed('late')
	expect(await p).toBe('late')
})

test('send writes straight to the socket', async () => {
	const ws = fakeWs()
	const { transport } = wsFeedTransport(ws)
	await transport.send('hello')
	expect(ws.sent).toEqual(['hello'])
})

test('abort rejects a pending receive', async () => {
	const { transport } = wsFeedTransport(fakeWs())
	const p = transport.receive()
	transport.abort?.(new Error('closed'))
	await expect(p).rejects.toThrow('closed')
})
