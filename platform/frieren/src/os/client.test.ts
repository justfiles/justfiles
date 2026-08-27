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
	private turn = 0
	private activeTurnId: string | null = null

	send(data: string): void {
		this.sent.push(data)
	}
	close(): void {
		this.readyState = 3
		this.onclose?.()
	}

	emit(frame: object): void {
		const value = frame as { type?: string; turnId?: string; event?: { type?: string } }
		if (value.type === 'history') {
			this.push({ ...frame, type: 'snapshot', activeTurn: null })
			return
		}
		if (value.type === 'event' && !value.turnId) {
			if (value.event?.type === 'agent_start' || !this.activeTurnId) {
				this.activeTurnId = `test-turn-${++this.turn}`
				this.push({
					type: 'turn_started',
					turn: {
						id: this.activeTurnId,
						input: { text: 'test input', source: 'user' }
					}
				})
			}
			this.push({ ...frame, turnId: this.activeTurnId })
			return
		}
		this.push(frame)
	}

	private push(frame: object): void {
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
	// Long enough that an emotion has served its minimum time on screen (client.ts HOLD_MS), so
	// a test about turn boundaries is not really a test about pacing.
	const HELD_LONG_ENOUGH = 5_000

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

	test('strips expression tags off the token stream, and paces the beats', async () => {
		const { client, connect } = setup()
		const socket = await connect()
		socket.emit({ type: 'ready', apps: [] })
		vi.useFakeTimers()
		try {
			socket.emit({ type: 'event', event: { type: 'agent_start' } })
			socket.emit({
				type: 'event',
				event: { type: 'message_start', message: { role: 'assistant' } }
			})
			// The tag straddles two deltas, as it does on a real stream.
			for (const delta of ['[ple', 'ased]Found it. ', '[concerned]Table is gone.']) {
				socket.emit({
					type: 'event',
					event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } }
				})
			}
			socket.emit({ type: 'event', event: { type: 'message_end' } })

			expect(client.agent.snapshot().messages.at(-1)).toMatchObject({
				role: 'assistant',
				content: 'Found it. Table is gone.'
			})
			// Both beats landed in the same instant, so the second is waiting rather than erasing
			// the first (see HOLD_MS).
			expect(client.agent.snapshot().expression).toBe('pleased')
			vi.advanceTimersByTime(3_000)
			expect(client.agent.snapshot().expression).toBe('concerned')
		} finally {
			vi.useRealTimers()
		}
	})

	test('an untagged reply rests, rather than wearing the last turn', async () => {
		const { client, connect } = setup()
		const socket = await connect()
		socket.emit({ type: 'ready', apps: [] })
		// A turn that earned an emotion...
		socket.emit({ type: 'event', event: { type: 'agent_start' } })
		socket.emit({ type: 'event', event: { type: 'message_start', message: { role: 'assistant' } } })
		socket.emit({
			type: 'event',
			event: {
				type: 'message_update',
				assistantMessageEvent: { type: 'text_delta', delta: '[concerned]That would drop it.' }
			}
		})
		socket.emit({ type: 'event', event: { type: 'agent_end' } })
		expect(client.agent.snapshot().expression).toBe('concerned')

		// ...must not lend it to the next one just because that one had no feeling to report.
		// There is no tag for calm: a plain sentence is how the agent stays quiet, and the rest
		// lands once the emotion has served its minimum on screen.
		vi.useFakeTimers()
		try {
			socket.emit({ type: 'event', event: { type: 'agent_start' } })
			socket.emit({
				type: 'event',
				event: { type: 'message_start', message: { role: 'assistant' } }
			})
			socket.emit({
				type: 'event',
				event: {
					type: 'message_update',
					assistantMessageEvent: { type: 'text_delta', delta: 'Done.' }
				}
			})
			socket.emit({ type: 'event', event: { type: 'agent_end' } })
			vi.advanceTimersByTime(5_000)
			expect(client.agent.snapshot().expression).toBe(null)
		} finally {
			vi.useRealTimers()
		}
	})

	test('an emotion is not replaced before it has been on screen long enough', async () => {
		const { client, connect } = setup()
		const socket = await connect()
		socket.emit({ type: 'ready', apps: [] })
		vi.useFakeTimers()
		try {
			socket.emit({ type: 'event', event: { type: 'agent_start' } })
			socket.emit({
				type: 'event',
				event: { type: 'message_start', message: { role: 'assistant' } }
			})
			// Two beats inside the same second, as a fast reply delivers them.
			for (const delta of ['[curious]Who’s there? ', '[pleased]Ha, good one.']) {
				socket.emit({
					type: 'event',
					event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } }
				})
				vi.advanceTimersByTime(300)
			}
			// The first beat is still up: the second is waiting its turn, not overwriting it.
			expect(client.agent.snapshot().expression).toBe('curious')
			vi.advanceTimersByTime(3_000)
			expect(client.agent.snapshot().expression).toBe('pleased')
		} finally {
			vi.useRealTimers()
		}
	})

	test('a face the user never registered survives an eager follow-up prompt', async () => {
		const { client, connect } = setup()
		const socket = await connect()
		socket.emit({ type: 'ready', apps: [] })
		vi.useFakeTimers()
		try {
			socket.emit({ type: 'event', event: { type: 'agent_start' } })
			socket.emit({
				type: 'event',
				event: { type: 'message_start', message: { role: 'assistant' } }
			})
			socket.emit({
				type: 'event',
				event: {
					type: 'message_update',
					assistantMessageEvent: { type: 'text_delta', delta: '[apologetic]That failed twice.' }
				}
			})
			socket.emit({ type: 'event', event: { type: 'agent_end' } })
			// The user fires off another prompt half a second later.
			vi.advanceTimersByTime(500)
			socket.emit({ type: 'event', event: { type: 'agent_start' } })
			expect(client.agent.snapshot().expression).toBe('apologetic')
			vi.advanceTimersByTime(3_000)
			expect(client.agent.snapshot().expression).toBe(null)
		} finally {
			vi.useRealTimers()
		}
	})

	test('a new reply starts from a clean face, so a tag cannot outlive its turn', async () => {
		const { client, connect } = setup()
		const socket = await connect()
		socket.emit({ type: 'ready', apps: [] })
		const reply = (deltas: string[]) => {
			socket.emit({ type: 'event', event: { type: 'agent_start' } })
			socket.emit({
				type: 'event',
				event: { type: 'message_start', message: { role: 'assistant' } }
			})
			for (const delta of deltas) {
				socket.emit({
					type: 'event',
					event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } }
				})
			}
			socket.emit({ type: 'event', event: { type: 'message_end' } })
			socket.emit({ type: 'event', event: { type: 'agent_end' } })
		}

		reply(['[apologetic]That failed.'])
		expect(client.agent.snapshot().expression).toBe('apologetic')

		// The face must be clean from `agent_start` on, not from the first token: streaming
		// (which un-rests the avatar) begins a second or more before the model answers. The
		// emotion's minimum on screen is the one thing that can delay it (covered separately);
		// here it has long since been served.
		vi.useFakeTimers()
		try {
			vi.advanceTimersByTime(HELD_LONG_ENOUGH)
			socket.emit({ type: 'event', event: { type: 'agent_start' } })
			expect(client.agent.snapshot().expression).toBe(null)

			// And a model that ignores the contract on this turn must not wear the old face.
			socket.emit({
				type: 'event',
				event: { type: 'message_start', message: { role: 'assistant' } }
			})
			socket.emit({
				type: 'event',
				event: {
					type: 'message_update',
					assistantMessageEvent: { type: 'text_delta', delta: 'Retried and it worked.' }
				}
			})
			expect(client.agent.snapshot().expression).toBe(null)
		} finally {
			vi.useRealTimers()
		}
	})

	test('promotes tool-result image refs onto the tool call, live and from history', async () => {
		const images = [{ src: '/pictures/abcd1234.png', mimeType: 'image/png', alt: 'a red panda' }]
		const { client, connect } = setup()
		const socket = await connect()

		socket.emit({
			type: 'history',
			messages: [
				{
					role: 'assistant',
					content: '',
					toolCalls: [{ name: 'generate_image', args: undefined, result: 'saved', images }]
				}
			]
		})
		socket.emit({ type: 'ready', apps: [] })
		expect(client.agent.snapshot().messages[0]?.toolCalls?.[0]?.images).toEqual(images)

		socket.emit({ type: 'event', event: { type: 'agent_start' } })
		socket.emit({ type: 'event', event: { type: 'message_start', message: { role: 'assistant' } } })
		socket.emit({
			type: 'event',
			event: {
				type: 'tool_execution_start',
				toolCallId: 'tc1',
				toolName: 'generate_image',
				args: { prompt: 'a red panda' }
			}
		})
		socket.emit({
			type: 'event',
			event: {
				type: 'tool_execution_end',
				toolCallId: 'tc1',
				toolName: 'generate_image',
				result: { content: [{ type: 'text', text: 'saved' }], details: { images } },
				isError: false
			}
		})

		const live = client.agent.snapshot().messages.at(-1)?.toolCalls?.[0]
		expect(live).toMatchObject({ status: 'done', images })
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

	test('waits for server admission before adding the prompt', async () => {
		const { client, connect } = setup()
		const socket = await connect()
		socket.emit({ type: 'ready', apps: [] })

		const accepted = client.agent.prompt('do the thing')
		expect(client.agent.snapshot()).toMatchObject({
			isStreaming: true,
			messages: []
		})
		expect(await client.agent.prompt('overlap')).toBe(false)

		const turn = { id: 'turn-1', input: { text: 'do the thing', source: 'user' } }
		socket.emit({ type: 'turn_started', turn })
		socket.emit({ type: 'prompt_result', accepted: true, turn })
		expect(await accepted).toBe(true)
		expect(client.agent.snapshot().messages).toEqual([
			expect.objectContaining({ id: 'turn-1', role: 'user', content: 'do the thing' })
		])
	})

	test('hydrates a late tab with the active app turn', async () => {
		const { client, connect } = setup()
		const socket = await connect()
		socket.emit({ type: 'ready', apps: [] })
		client.agent.loadHistory('notes')
		socket.emit({
			type: 'snapshot',
			agentId: 'notes',
			messages: [{ role: 'user', content: 'older question' }],
			activeTurn: { id: 'active-1', input: { text: 'running now', source: 'user' } }
		})

		expect(client.agent.snapshot('notes')).toMatchObject({
			isStreaming: true,
			isLoadingHistory: false,
			messages: [
				expect.objectContaining({ content: 'older question' }),
				expect.objectContaining({ id: 'active-1', content: 'running now' })
			]
		})
		expect(await client.agent.prompt('overlap', 'notes')).toBe(false)
	})

	test('uses the active turn id for stop and ignores an old finish', async () => {
		const { client, connect } = setup()
		const socket = await connect()
		socket.emit({ type: 'ready', apps: [] })
		socket.emit({
			type: 'turn_started',
			agentId: 'notes',
			turn: { id: 'new-turn', input: { text: 'new work', source: 'user' } }
		})
		client.agent.abort('notes')
		socket.emit({
			type: 'turn_finished',
			agentId: 'notes',
			turnId: 'old-turn',
			status: 'completed',
			messages: []
		})

		expect(socket.sent.map((frame) => JSON.parse(frame))).toContainEqual({
			type: 'abort',
			turnId: 'new-turn',
			agentId: 'notes'
		})
		expect(client.agent.snapshot('notes').isStreaming).toBe(true)
	})

	test('does not submit a turn while app history loads', async () => {
		const { client, connect } = setup()
		const socket = await connect()
		socket.emit({ type: 'ready', apps: [] })
		client.agent.loadHistory('notes')

		expect(await client.agent.prompt('too soon', 'notes')).toBe(false)
		expect(client.agent.snapshot('notes')).toMatchObject({
			isStreaming: false,
			isLoadingHistory: true,
			messages: []
		})

		socket.emit({ type: 'snapshot', agentId: 'notes', messages: [], activeTurn: null })
		expect(client.agent.snapshot('notes').isLoadingHistory).toBe(false)
		expect(socket.sent.map((frame) => JSON.parse(frame))).toContainEqual({
			type: 'snapshot',
			agentId: 'notes'
		})
	})

	test('prompt is a no-op before the connection is ready', async () => {
		const { client, connect } = setup()
		const socket = await connect()

		expect(await client.agent.prompt('too early')).toBe(false)

		expect(client.agent.snapshot().messages).toEqual([])
		expect(socket.sent).toEqual([])
	})

	test('disconnect on socket close clears streaming', async () => {
		const { client, connect } = setup()
		const socket = await connect()
		socket.emit({ type: 'ready', apps: [] })
		const accepted = client.agent.prompt('pending')

		socket.close()

		expect(client.agent.snapshot().connectionState).toBe('disconnected')
		expect(client.agent.snapshot().isStreaming).toBe(false)
		expect(await accepted).toBe(false)
	})
})

describe('FrierenClient apps + windows', () => {
	test('connect replays local catalog while offline', async () => {
		const client = createFrierenClient({
			getToken: async () => null,
			listLocalApps: async () => [{ id: 'paint', name: 'Paint', description: '' }]
		})
		const seen: string[][] = []
		client.subscribeApps((apps) => seen.push(apps.map((a) => a.id)))

		client.connect()
		await flush()

		expect(seen.at(-1)).toEqual(['paint'])
		expect(client.agent.snapshot().connectionState).toBe('disconnected')
	})

	test('subscribeApps replays the current catalog and receives ready updates', async () => {
		const { client, connect } = setup()
		const socket = await connect()

		const seen: string[][] = []
		client.subscribeApps((apps) => seen.push(apps.map((a) => a.id)))
		expect(seen).toEqual([[]]) // replay before any ready frame

		socket.emit({
			type: 'ready',
			apps: [{ id: 'notes', name: 'Notes', description: '' }]
		})
		expect(seen.at(-1)).toEqual(['notes'])
	})

	test('ready prefers the local catalog when available', async () => {
		const sockets: FakeSocket[] = []
		const client = createFrierenClient({
			getToken: async () => 'tok',
			listLocalApps: async () => [{ id: 'local', name: 'Local', description: '' }],
			createSocket: () => {
				const socket = new FakeSocket()
				sockets.push(socket)
				return socket
			}
		})
		const seen: string[][] = []
		client.subscribeApps((apps) => seen.push(apps.map((a) => a.id)))

		client.connect()
		await flush()
		const socket = sockets[0]
		if (!socket) throw new Error('socket not created')
		socket.emit({ type: 'ready', apps: [{ id: 'server', name: 'Server', description: '' }] })
		await flush()

		expect(seen.at(-1)).toEqual(['local'])
	})

	test('refresh does not re-notify when the local catalog is unchanged', async () => {
		const client = createFrierenClient({
			getToken: async () => null,
			// Fresh objects each call, identical values — mirrors the `/applications`
			// watcher firing on an unrelated structural write and re-listing the kernel.
			listLocalApps: async () => [{ id: 'paint', name: 'Paint', description: '', version: '1.0.0' }]
		})
		const seen: string[][] = []
		client.subscribeApps((apps) => seen.push(apps.map((a) => a.id))) // replay: []

		client.refresh()
		await flush()
		client.refresh()
		await flush()

		// First load emits ['paint']; the unchanged re-list is dropped.
		expect(seen).toEqual([[], ['paint']])
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

describe('FrierenClient sync poke', () => {
	test('a sync frame runs the onSync handler (server->client volume poke)', async () => {
		const { client, connect } = setup()
		const socket = await connect()
		let synced = 0
		client.onSync(() => {
			synced++
		})
		socket.emit({ type: 'ready', apps: [] })
		socket.emit({ type: 'sync' })
		expect(synced).toBe(1)
	})
})

describe('FrierenClient reconnection', () => {
	test('reconnects the session socket after an unexpected close', async () => {
		vi.useFakeTimers()
		try {
			const sockets: FakeSocket[] = []
			const client = createFrierenClient({
				getToken: async () => 'tok',
				createSocket: () => {
					const s = new FakeSocket()
					sockets.push(s)
					return s
				}
			})
			client.connect()
			await vi.advanceTimersByTimeAsync(0)
			expect(sockets).toHaveLength(1)

			// A transient drop (not an explicit client.close()) must self-heal.
			sockets[0].close()
			await vi.advanceTimersByTimeAsync(5_000)
			expect(sockets.length).toBeGreaterThan(1)

			// An explicit close stops reconnecting.
			const count = sockets.length
			client.close()
			await vi.advanceTimersByTimeAsync(60_000)
			expect(sockets.length).toBe(count)
		} finally {
			vi.useRealTimers()
		}
	})
})
