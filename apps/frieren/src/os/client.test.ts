import { describe, expect, test, vi } from 'vitest'
import { createFrierenClient, type SocketLike } from './client'
import type { OsAction } from './state'

class FakeSocket implements SocketLike {
	readyState = 1
	sent: string[] = []
	onopen: (() => void) | null = null
	onmessage: ((event: { data: string }) => void) | null = null
	onclose: (() => void) | null = null
	onerror: (() => void) | null = null

	send(data: string): void {
		this.sent.push(data)
	}
	close(): void {
		this.readyState = 3
		this.onclose?.()
	}

	emit(frame: object): void {
		this.onmessage?.({ data: JSON.stringify(frame) })
	}
}

// Flush the async token resolution inside connect().
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function setup() {
	let socket: FakeSocket | null = null
	const client = createFrierenClient({
		getToken: async () => 'tok',
		createSocket: () => {
			socket = new FakeSocket()
			return socket
		}
	})
	return {
		client,
		async connect(): Promise<FakeSocket> {
			client.connect()
			await flush()
			if (!socket) throw new Error('socket not created')
			return socket
		}
	}
}

describe('FrierenClient agent', () => {
	test('snapshot hydrates from ready/history received before any subscriber', async () => {
		const { client, connect } = setup()
		const socket = await connect()

		socket.emit({
			type: 'history',
			participants: { userName: 'Stark', agentName: 'Fern' },
			messages: [{ role: 'user', content: 'hello' }]
		})
		socket.emit({ type: 'ready', participants: { userName: 'Stark', agentName: 'Fern' }, apps: [] })

		const snapshot = client.agent.snapshot()
		expect(snapshot.connectionState).toBe('ready')
		expect(snapshot.userName).toBe('Stark')
		expect(snapshot.agentName).toBe('Fern')
		expect(snapshot.messages).toHaveLength(1)
		expect(snapshot.messages[0]).toMatchObject({ role: 'user', content: 'hello' })
	})

	test('subscribe is notified of future streaming events and snapshot reflects them', async () => {
		const { client, connect } = setup()
		const socket = await connect()
		socket.emit({ type: 'ready', apps: [] })

		const listener = vi.fn()
		client.agent.subscribe(listener)

		socket.emit({ type: 'event', event: { type: 'agent_start' } })
		socket.emit({ type: 'event', event: { type: 'message_start', message: { role: 'assistant' } } })
		socket.emit({
			type: 'event',
			event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hi' } }
		})
		socket.emit({
			type: 'event',
			event: {
				type: 'message_update',
				assistantMessageEvent: { type: 'text_delta', delta: ' there' }
			}
		})

		expect(listener).toHaveBeenCalled()
		const snapshot = client.agent.snapshot()
		expect(snapshot.isStreaming).toBe(true)
		expect(snapshot.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Hi there' })
	})

	test('snapshot returns a stable reference until state changes', async () => {
		const { client, connect } = setup()
		const socket = await connect()
		socket.emit({ type: 'ready', apps: [] })

		const first = client.agent.snapshot()
		expect(client.agent.snapshot()).toBe(first)

		socket.emit({ type: 'event', event: { type: 'agent_start' } })
		expect(client.agent.snapshot()).not.toBe(first)
	})

	test('prompt appends the user message and sends a prompt frame', async () => {
		const { client, connect } = setup()
		const socket = await connect()
		socket.emit({ type: 'ready', apps: [] })

		client.agent.prompt('do the thing')

		expect(client.agent.snapshot().messages).toEqual([
			expect.objectContaining({ role: 'user', content: 'do the thing' })
		])
		expect(socket.sent.map((s) => JSON.parse(s))).toContainEqual({
			type: 'prompt',
			text: 'do the thing'
		})
	})

	test('prompt is a no-op before the connection is ready', async () => {
		const { client, connect } = setup()
		const socket = await connect()

		client.agent.prompt('too early')

		expect(client.agent.snapshot().messages).toEqual([])
		expect(socket.sent).toEqual([])
	})

	test('disconnect on socket close clears streaming', async () => {
		const { client, connect } = setup()
		const socket = await connect()
		socket.emit({ type: 'ready', apps: [] })
		socket.emit({ type: 'event', event: { type: 'agent_start' } })

		socket.close()

		expect(client.agent.snapshot().connectionState).toBe('disconnected')
		expect(client.agent.snapshot().isStreaming).toBe(false)
	})
})

describe('FrierenClient apps + windows', () => {
	test('subscribeApps replays the current catalog and receives ready updates', async () => {
		const { client, connect } = setup()
		const socket = await connect()

		const seen: string[][] = []
		client.subscribeApps((apps) => seen.push(apps.map((a) => a.id)))
		expect(seen).toEqual([[]]) // replay before any ready frame

		socket.emit({
			type: 'ready',
			apps: [{ id: 'notes', name: 'Notes', description: '', guiUrl: '/api/apps/notes/gui.js' }]
		})
		expect(seen.at(-1)).toEqual(['notes'])
		expect(client.guiUrlFor('notes')).toBe('/api/apps/notes/gui.js')
	})

	test('removeApp drops the app from the catalog and notifies subscribers', async () => {
		const { client, connect } = setup()
		const socket = await connect()
		socket.emit({
			type: 'ready',
			apps: [
				{ id: 'notes', name: 'Notes', description: '' },
				{ id: 'mail', name: 'Mail', description: '' }
			]
		})

		const seen: string[][] = []
		client.subscribeApps((apps) => seen.push(apps.map((a) => a.id)))

		client.removeApp('notes')
		expect(seen.at(-1)).toEqual(['mail'])

		// Removing an unknown app is a no-op (no extra notification).
		const before = seen.length
		client.removeApp('notes')
		expect(seen.length).toBe(before)
	})

	test('app_open/close route to the remote-window handler', async () => {
		const { client, connect } = setup()
		const socket = await connect()
		socket.emit({ type: 'ready', apps: [{ id: 'notes', name: 'Notes', description: '' }] })

		const actions: OsAction[] = []
		client.onRemoteWindow((action) => actions.push(action))

		socket.emit({ type: 'app_open', id: 'notes' })
		socket.emit({ type: 'app_close', id: 'notes' })

		expect(actions).toEqual([
			{ type: 'app.open', appId: 'notes', title: 'Notes', remote: true },
			{ type: 'window.close', id: 'notes', remote: true }
		])
	})
})
