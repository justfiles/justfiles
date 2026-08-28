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
		const value = frame as {
			type?: string
			event?: { type?: string; assistantMessageEvent?: { type?: string } }
		}
		if (value.type === 'event' && value.event) {
			const state = value.event.type?.startsWith('tool_execution_')
				? 'calling_tool'
				: value.event.assistantMessageEvent?.type === 'text_delta'
					? 'responding'
					: 'thinking'
			this.push({
				type: 'status',
				status: { state, detail: value.event }
			})
			return
		}
		this.push(frame)
	}

	private push(frame: object): void {
		this.onmessage?.({ data: JSON.stringify(frame) })
	}
}

class FakeConnections {
	private readonly sockets = new Map<string, FakeSocket>()

	add(path: string): FakeSocket {
		const socket = new FakeSocket()
		this.sockets.set(path, socket)
		return socket
	}

	agent(agentId?: string): FakeSocket {
		const path = `/api/agents/${encodeURIComponent(agentId ?? 'main')}/connect`
		const socket = this.sockets.get(path)
		if (!socket) throw new Error(`socket not created: ${path}`)
		return socket
	}

	emit(frame: object): void {
		const value = frame as { type?: string; agentId?: string }
		if (
			value.type === 'ready' ||
			value.type === 'app_open' ||
			value.type === 'app_close' ||
			value.type === 'notification' ||
			value.type === 'sync'
		) {
			const socket = this.sockets.get('/ws')
			if (!socket) throw new Error('control socket not created')
			socket.emit(frame)
			return
		}
		const { agentId, ...message } = value
		this.agent(agentId).emit(message)
	}

	get sent(): string[] {
		return [...this.sockets.values()].flatMap((socket) => socket.sent)
	}

	close(): void {
		this.agent().close()
	}
}

// Flush the async token resolution inside connect().
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function setup() {
	const sockets = new FakeConnections()
	const client = createFrierenClient({
		getToken: async () => 'tok',
		createSocket: (_token, path) => sockets.add(path)
	})
	return {
		client,
		async connect(): Promise<FakeConnections> {
			client.connect()
			client.agent().connect()
			await flush()
			sockets.agent().emit({ type: 'snapshot', history: [], status: { state: 'idle' } })
			return sockets
		}
	}
}

describe('FrierenClient agent', () => {
	// Long enough that an emotion has served its minimum time on screen (client.ts HOLD_MS), so
	// a test about turn boundaries is not really a test about pacing.
	const HELD_LONG_ENOUGH = 5_000

	test('snapshot hydrates history received before any subscriber', async () => {
		const { client, connect } = setup()
		const socket = await connect()

		socket.emit({
			type: 'snapshot',
			history: [{ role: 'user', content: 'hello' }],
			status: { state: 'idle' }
		})
		socket.emit({ type: 'ready', participants: { userName: 'Stark', agentName: 'Fern' }, apps: [] })

		const snapshot = client.agent().snapshot()
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
		client.agent().subscribe(listener)

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
		const snapshot = client.agent().snapshot()
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

			expect(client.agent().snapshot().messages.at(-1)).toMatchObject({
				role: 'assistant',
				content: 'Found it. Table is gone.'
			})
			// Both beats landed in the same instant, so the second is waiting rather than erasing
			// the first (see HOLD_MS).
			expect(client.agent().snapshot().expression).toBe('pleased')
			vi.advanceTimersByTime(3_000)
			expect(client.agent().snapshot().expression).toBe('concerned')
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
		expect(client.agent().snapshot().expression).toBe('concerned')

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
			expect(client.agent().snapshot().expression).toBe(null)
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
			expect(client.agent().snapshot().expression).toBe('curious')
			vi.advanceTimersByTime(3_000)
			expect(client.agent().snapshot().expression).toBe('pleased')
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
			expect(client.agent().snapshot().expression).toBe('apologetic')
			vi.advanceTimersByTime(3_000)
			expect(client.agent().snapshot().expression).toBe(null)
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
		expect(client.agent().snapshot().expression).toBe('apologetic')

		// The face must be clean from `agent_start` on, not from the first token: streaming
		// (which un-rests the avatar) begins a second or more before the model answers. The
		// emotion's minimum on screen is the one thing that can delay it (covered separately);
		// here it has long since been served.
		vi.useFakeTimers()
		try {
			vi.advanceTimersByTime(HELD_LONG_ENOUGH)
			socket.emit({ type: 'event', event: { type: 'agent_start' } })
			expect(client.agent().snapshot().expression).toBe(null)

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
			expect(client.agent().snapshot().expression).toBe(null)
		} finally {
			vi.useRealTimers()
		}
	})

	test('promotes tool-result image refs onto the tool call, live and from history', async () => {
		const images = [{ src: '/pictures/abcd1234.png', mimeType: 'image/png', alt: 'a red panda' }]
		const { client, connect } = setup()
		const socket = await connect()

		socket.emit({
			type: 'snapshot',
			history: [
				{
					id: 'activity-1',
					type: 'activity',
					label: 'Generate image · 0.1s',
					items: []
				},
				{
					id: 'activity-1:image:0',
					type: 'image',
					image: images[0]
				}
			],
			status: { state: 'idle' }
		})
		socket.emit({ type: 'ready', apps: [] })
		expect(client.agent().snapshot().messages[1]).toEqual({
			id: 'activity-1:image:0',
			type: 'image',
			image: images[0]
		})

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

		const message = client.agent().snapshot().messages.at(-1)
		const live = message && !('type' in message) ? message.toolCalls?.[0] : undefined
		expect(live).toMatchObject({ status: 'done', images })
	})

	test('restores ask_user options from history', async () => {
		const options = [{ label: 'Tea' }, { label: 'Coffee' }]
		const { client, connect } = setup()
		const socket = await connect()

		socket.emit({
			type: 'snapshot',
			history: [{ role: 'assistant', content: 'Tea or coffee?', options }],
			status: { state: 'idle' }
		})

		expect(client.agent().snapshot().messages[0]).toMatchObject({
			content: 'Tea or coffee?',
			options
		})
	})

	test('matches activity detail replies to their request', async () => {
		const { client, connect } = setup()
		const sockets = await connect()
		const pending = client.agent().loadActivityDetail('detail-1')
		const request = JSON.parse(sockets.agent().sent.at(-1) ?? '') as {
			requestId: string
			detailId: string
		}
		expect(request.detailId).toBe('detail-1')

		sockets.agent().emit({
			type: 'activity_detail',
			requestId: request.requestId,
			result: {
				status: 'available',
				detail: { items: [{ kind: 'think', content: 'Checked it.' }] }
			}
		})
		await expect(pending).resolves.toEqual({
			status: 'available',
			detail: { items: [{ kind: 'think', content: 'Checked it.' }] }
		})
	})

	test('snapshot returns a stable reference until state changes', async () => {
		const { client, connect } = setup()
		const socket = await connect()
		socket.emit({ type: 'ready', apps: [] })

		const first = client.agent().snapshot()
		expect(client.agent().snapshot()).toBe(first)

		socket.emit({ type: 'event', event: { type: 'agent_start' } })
		expect(client.agent().snapshot()).not.toBe(first)
	})

	test('waits for server admission before adding the prompt', async () => {
		const { client, connect } = setup()
		const socket = await connect()
		socket.emit({ type: 'ready', apps: [] })

		const accepted = client.agent().prompt('do the thing')
		expect(client.agent().snapshot()).toMatchObject({
			isStreaming: true,
			messages: []
		})
		expect(await client.agent().prompt('overlap')).toBe(false)

		socket.emit({ type: 'status', status: { state: 'thinking' } })
		socket.emit({ type: 'accepted' })
		expect(await accepted).toBe(true)
		expect(client.agent().snapshot()).toMatchObject({ isStreaming: true, messages: [] })

		socket.emit({
			type: 'item',
			item: { id: 'prompt-1', type: 'message', role: 'user', content: 'do the thing' }
		})
		expect(client.agent().snapshot().messages).toEqual([
			expect.objectContaining({ role: 'user', content: 'do the thing' })
		])
	})

	test('a rejected prompt leaves the running session untouched', async () => {
		const { client, connect } = setup()
		const socket = await connect()
		socket.emit({ type: 'ready', apps: [] })

		const accepted = client.agent().prompt('my prompt')
		socket.emit({
			type: 'item',
			item: { id: 'prompt-2', type: 'message', role: 'user', content: 'already running' }
		})
		socket.emit({ type: 'status', status: { state: 'thinking' } })
		socket.emit({ type: 'rejected', reason: 'busy' })

		expect(await accepted).toBe(false)
		expect(client.agent().snapshot()).toMatchObject({
			isStreaming: true,
			messages: [expect.objectContaining({ content: 'already running' })]
		})
	})

	test('an ignored debug prompt returns the client to idle', async () => {
		const { client, connect } = setup()
		const socket = await connect()
		socket.emit({ type: 'ready', apps: [] })

		const accepted = client.agent().prompt('/debug')
		socket.emit({ type: 'debug', message: 'system prompt' })

		expect(await accepted).toBe(false)
		expect(client.agent().snapshot().isStreaming).toBe(false)
	})

	test('hydrates a late tab with the active app turn', async () => {
		const { client, connect } = setup()
		const socket = await connect()
		socket.emit({ type: 'ready', apps: [] })
		client.agent('notes').connect()
		await flush()
		socket.emit({
			type: 'snapshot',
			agentId: 'notes',
			history: [
				{ role: 'user', content: 'older question' },
				{ role: 'user', content: 'running now' }
			],
			status: { state: 'thinking' }
		})

		expect(client.agent('notes').snapshot()).toMatchObject({
			isStreaming: true,
			isLoadingHistory: false,
			messages: [
				expect.objectContaining({ content: 'older question' }),
				expect.objectContaining({ content: 'running now' })
			]
		})
		expect(await client.agent('notes').prompt('overlap')).toBe(false)
	})

	test('stop targets the current session without a turn id', async () => {
		const { client, connect } = setup()
		const socket = await connect()
		socket.emit({ type: 'ready', apps: [] })
		client.agent('notes').connect()
		await flush()
		socket.emit({
			type: 'snapshot',
			agentId: 'notes',
			history: [{ role: 'user', content: 'new work' }],
			status: { state: 'thinking' }
		})
		client.agent('notes').abort()
		socket.emit({
			type: 'event',
			agentId: 'notes',
			event: { type: 'message_start', message: { role: 'assistant' } }
		})

		expect(socket.agent('notes').sent.map((frame) => JSON.parse(frame))).toContainEqual({
			type: 'abort'
		})
		expect(client.agent('notes').snapshot().isStreaming).toBe(true)
	})

	test('does not submit a turn while app history loads', async () => {
		const { client, connect } = setup()
		const socket = await connect()
		socket.emit({ type: 'ready', apps: [] })
		client.agent('notes').connect()
		await flush()

		expect(await client.agent('notes').prompt('too soon')).toBe(false)
		expect(client.agent('notes').snapshot()).toMatchObject({
			isStreaming: false,
			isLoadingHistory: true,
			messages: []
		})

		socket.emit({
			type: 'snapshot',
			agentId: 'notes',
			history: [],
			status: { state: 'idle' }
		})
		expect(client.agent('notes').snapshot().isLoadingHistory).toBe(false)
		expect(socket.agent('notes').sent).toEqual([])
	})

	test('prompt is a no-op before the connection is ready', async () => {
		const { client } = setup()
		client.connect()

		expect(await client.agent().prompt('too early')).toBe(false)

		expect(client.agent().snapshot().messages).toEqual([])
	})

	test('disconnect on socket close clears streaming', async () => {
		const { client, connect } = setup()
		const socket = await connect()
		socket.emit({ type: 'ready', apps: [] })
		const accepted = client.agent().prompt('pending')

		socket.close()

		expect(client.agent().snapshot().connectionState).toBe('disconnected')
		expect(client.agent().snapshot().isStreaming).toBe(false)
		expect(await accepted).toBe(false)
	})

	test('closes a session socket when its last client disconnects', async () => {
		const sockets = new FakeConnections()
		const client = createFrierenClient({
			getToken: async () => 'tok',
			createSocket: (_token, path) => sockets.add(path)
		})
		client.connect()
		const disconnect = client.agent('notes').connect()
		await flush()
		const socket = sockets.agent('notes')

		disconnect()

		expect(socket.readyState).toBe(3)
		expect(client.agent('notes').snapshot().connectionState).toBe('disconnected')
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
		expect(client.agent().snapshot().connectionState).toBe('disconnected')
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
		const sockets = new Map<string, FakeSocket>()
		const client = createFrierenClient({
			getToken: async () => 'tok',
			listLocalApps: async () => [{ id: 'local', name: 'Local', description: '' }],
			createSocket: (_token, path) => {
				const socket = new FakeSocket()
				sockets.set(path, socket)
				return socket
			}
		})
		const seen: string[][] = []
		client.subscribeApps((apps) => seen.push(apps.map((a) => a.id)))

		client.connect()
		await flush()
		const socket = sockets.get('/ws')
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
	test('reconnects an agent socket after an unexpected close', async () => {
		vi.useFakeTimers()
		try {
			const sockets: { path: string; socket: FakeSocket }[] = []
			const client = createFrierenClient({
				getToken: async () => 'tok',
				createSocket: (_token, path) => {
					const s = new FakeSocket()
					sockets.push({ path, socket: s })
					return s
				}
			})
			client.connect()
			client.agent().connect()
			await vi.advanceTimersByTimeAsync(0)
			expect(sockets).toHaveLength(2)

			// A transient drop (not an explicit client.close()) must self-heal.
			sockets.find(({ path }) => path === '/api/agents/main/connect')?.socket.close()
			await vi.advanceTimersByTimeAsync(5_000)
			expect(sockets.filter(({ path }) => path === '/api/agents/main/connect')).toHaveLength(2)

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
