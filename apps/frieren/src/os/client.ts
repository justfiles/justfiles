import type { AgentMessage, ConnectionState } from '../agent/types'
import type { InstalledApp } from '../apps/types'
import type { OsAction } from './state'

// WebSocket.OPEN; spelled out so the readyState check doesn't depend on the
// browser global being present (tests run under node).
const SOCKET_OPEN = 1

// Minimal socket surface the client drives; the real `WebSocket` satisfies it.
// Tests inject a fake via `createSocket`.
export interface SocketLike {
	send(data: string): void
	close(): void
	readyState: number
	onopen: (() => void) | null
	onmessage: ((event: { data: string }) => void) | null
	onclose: (() => void) | null
	onerror: (() => void) | null
}

// Latest agent session state. Held as an immutable snapshot so consumers can
// drive it through `useSyncExternalStore` (BehaviorSubject pattern: current
// value + subscription, no unbounded event log).
export interface AgentSnapshot {
	connectionState: ConnectionState
	userName: string
	agentName: string
	messages: AgentMessage[]
	isStreaming: boolean
}

export interface AgentClient {
	prompt(text: string): void
	abort(): void
	subscribe(listener: () => void): () => void
	snapshot(): AgentSnapshot
}

export interface FrierenClient {
	connect(): void
	close(): void
	// Re-list installed apps from the local profile volume (e.g. after install).
	refresh(): void
	send(frame: object): void
	agent: AgentClient
	subscribeApps(listener: (apps: InstalledApp[]) => void): () => void
	// Drop an app from the catalog optimistically (uninstall); refresh() is authoritative.
	removeApp(id: string): void
	onRemoteWindow(handler: (action: OsAction) => void): () => void
}

export interface FrierenClientOptions {
	getToken: () => Promise<string | null>
	// Local catalog fallback for offline boot; online `ready` remains authoritative.
	listLocalApps?: () => Promise<InstalledApp[]>
	// Inject the transport for tests; defaults to a browser WebSocket on /ws.
	createSocket?: (token: string) => SocketLike
}

// Streaming agent payload carried by `event` frames from the worker.
interface AgentEventFrame {
	type: string
	message?: { role: string }
	assistantMessageEvent?: { type: string; delta?: string }
	toolCallId?: string
	toolName?: string
	args?: unknown
	result?: unknown
	isError?: boolean
}

interface HistoryMessage {
	role: string
	content: string
	source?: 'user' | 'app'
	thinking?: string
	toolCalls?: { name: string; args: unknown; result?: unknown; isError?: boolean }[]
}

interface ServerFrame {
	type?: string
	participants?: { userName?: string; agentName?: string }
	apps?: unknown
	messages?: HistoryMessage[]
	message?: string
	id?: string
	event?: AgentEventFrame
}

function defaultCreateSocket(token: string): SocketLike {
	const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
	return new WebSocket(
		`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`
	) as unknown as SocketLike
}

export function createFrierenClient(options: FrierenClientOptions): FrierenClient {
	const createSocket = options.createSocket ?? defaultCreateSocket

	let socket: SocketLike | null = null
	// Bumped on every (re)connect/close so a stale async token resolution from a
	// superseded connect attempt is ignored.
	let generation = 0

	// --- agent session (BehaviorSubject) ---
	let connectionState: ConnectionState = 'disconnected'
	let userName = 'You'
	let agentName = 'Frieren'
	let messages: AgentMessage[] = []
	let isStreaming = false
	let currentAssistantId: string | null = null

	const agentListeners = new Set<() => void>()
	let agentSnapshot: AgentSnapshot = buildAgentSnapshot()

	function buildAgentSnapshot(): AgentSnapshot {
		return { connectionState, userName, agentName, messages, isStreaming }
	}

	function emitAgent(): void {
		agentSnapshot = buildAgentSnapshot()
		for (const listener of agentListeners) listener()
	}

	function setMessages(next: AgentMessage[]): void {
		messages = next
		emitAgent()
	}

	function mapMessages(fn: (message: AgentMessage) => AgentMessage): void {
		setMessages(messages.map(fn))
	}

	// --- installed-app catalog ---
	let apps: InstalledApp[] = []
	const appsListeners = new Set<(apps: InstalledApp[]) => void>()

	function emitApps(): void {
		for (const listener of appsListeners) listener(apps)
	}

	// Re-listing the local catalog yields fresh objects with identical values, so
	// skip the emit when nothing changed — a churny watch shouldn't restart bundle
	// hydration on every `subscribeApps` consumer.
	function sameApps(a: InstalledApp[], b: InstalledApp[]): boolean {
		return (
			a.length === b.length &&
			a.every((app, i) => {
				const other = b[i]
				return (
					app.id === other.id &&
					app.name === other.name &&
					app.description === other.description &&
					app.version === other.version &&
					app.iconUrl === other.iconUrl
				)
			})
		)
	}

	function setApps(next: InstalledApp[]): void {
		if (sameApps(apps, next)) return
		apps = next
		emitApps()
	}

	function loadLocalApps(fallback?: InstalledApp[]): void {
		if (!options.listLocalApps) {
			if (fallback) setApps(fallback)
			return
		}
		void options
			.listLocalApps()
			.then(setApps)
			.catch(() => {
				if (fallback) setApps(fallback)
			})
	}

	// --- server-echoed window open/close ---
	let remoteWindow: ((action: OsAction) => void) | null = null

	function handleAgentEvent(event: AgentEventFrame): void {
		switch (event.type) {
			case 'agent_start':
				isStreaming = true
				emitAgent()
				break

			case 'agent_end':
				isStreaming = false
				currentAssistantId = null
				emitAgent()
				break

			case 'message_start': {
				if (event.message?.role === 'assistant') {
					const id = crypto.randomUUID()
					currentAssistantId = id
					setMessages([
						...messages,
						{ id, role: 'assistant', content: '', thinking: '', toolCalls: [] }
					])
				}
				break
			}

			case 'message_update': {
				const id = currentAssistantId
				if (!id) break
				const delta = event.assistantMessageEvent
				if (delta?.type === 'text_delta' && delta.delta) {
					const text = delta.delta
					mapMessages((message) =>
						message.id === id ? { ...message, content: message.content + text } : message
					)
				}
				if (delta?.type === 'thinking_delta' && delta.delta) {
					const text = delta.delta
					mapMessages((message) =>
						message.id === id ? { ...message, thinking: (message.thinking ?? '') + text } : message
					)
				}
				break
			}

			case 'tool_execution_start': {
				const id = currentAssistantId
				if (!id || !event.toolCallId || !event.toolName) break
				const toolCallId = event.toolCallId
				const toolName = event.toolName
				mapMessages((message) =>
					message.id === id
						? {
								...message,
								toolCalls: [
									...(message.toolCalls ?? []),
									{ id: toolCallId, name: toolName, args: event.args, status: 'running' as const }
								]
							}
						: message
				)
				break
			}

			case 'tool_execution_end': {
				const id = currentAssistantId
				if (!id) break
				mapMessages((message) =>
					message.id === id
						? {
								...message,
								toolCalls: message.toolCalls?.map((toolCall) =>
									toolCall.id === event.toolCallId
										? {
												...toolCall,
												result: event.result,
												isError: event.isError,
												status: 'done' as const
											}
										: toolCall
								)
							}
						: message
				)
				break
			}
		}
	}

	function handleFrame(data: ServerFrame): void {
		if (data.type === 'ready') {
			if (data.participants) {
				userName = data.participants.userName || 'You'
				agentName = data.participants.agentName || 'Frieren'
			}
			connectionState = 'ready'
			emitAgent()
			loadLocalApps(Array.isArray(data.apps) ? (data.apps as InstalledApp[]) : [])
			return
		}

		if (data.type === 'history') {
			if (data.participants) {
				userName = data.participants.userName || 'You'
				agentName = data.participants.agentName || 'Frieren'
			}
			const restored: AgentMessage[] = (data.messages ?? []).map((m) => ({
				id: crypto.randomUUID(),
				role: m.role as 'user' | 'assistant',
				content: m.content,
				source: m.source,
				thinking: m.thinking,
				toolCalls: m.toolCalls?.map((tc) => ({
					id: crypto.randomUUID(),
					name: tc.name,
					args: tc.args,
					result: tc.result,
					isError: tc.isError,
					status: 'done' as const
				}))
			}))
			if (restored.length > 0) messages = restored
			emitAgent()
			return
		}

		if (data.type === 'error') {
			console.error('Server error:', data.message)
			isStreaming = false
			// Surface the failure in the transcript (an error-styled block), not just the
			// console — e.g. "turn on an AI provider in Settings" when no AI is enabled.
			const body = typeof data.message === 'string' ? data.message : 'Something went wrong.'
			setMessages([
				...messages,
				{ id: crypto.randomUUID(), role: 'assistant', content: body, error: true }
			])
			return
		}

		// TODO: remove later
		if (data.type === 'debug') {
			console.log(String(data.message ?? ''))
			return
		}

		if (data.type === 'app_open') {
			const id = data.id as string
			const title = apps.find((app) => app.id === id)?.name
			remoteWindow?.({ type: 'app.open', appId: id, title, remote: true })
			return
		}

		if (data.type === 'app_close') {
			remoteWindow?.({ type: 'window.close', id: data.id as string, remote: true })
			return
		}

		if (data.type === 'event' && data.event) handleAgentEvent(data.event)
	}

	function attach(ws: SocketLike): void {
		ws.onmessage = (event) => {
			let data: ServerFrame
			try {
				data = JSON.parse(event.data) as ServerFrame
			} catch {
				return
			}
			handleFrame(data)
		}
		ws.onclose = () => {
			if (socket !== ws) return
			socket = null
			connectionState = 'disconnected'
			isStreaming = false
			emitAgent()
			loadLocalApps()
		}
		ws.onerror = () => {
			if (socket !== ws) return
			connectionState = 'disconnected'
			isStreaming = false
			emitAgent()
			loadLocalApps()
		}
	}

	function closeSocket(): void {
		const ws = socket
		socket = null
		ws?.close()
	}

	function connect(): void {
		const gen = ++generation
		closeSocket()
		connectionState = 'connecting'
		isStreaming = false
		emitAgent()
		void (async () => {
			const token = await options.getToken().catch(() => null)
			if (gen !== generation) return
			if (!token) {
				connectionState = 'disconnected'
				emitAgent()
				loadLocalApps()
				return
			}
			const ws = createSocket(token)
			socket = ws
			attach(ws)
		})()
	}

	const agent: AgentClient = {
		prompt(text) {
			if (!socket || socket.readyState !== SOCKET_OPEN || connectionState !== 'ready') return
			setMessages([...messages, { id: crypto.randomUUID(), role: 'user', content: text }])
			socket.send(JSON.stringify({ type: 'prompt', text }))
		},
		abort() {
			socket?.send(JSON.stringify({ type: 'abort' }))
		},
		subscribe(listener) {
			agentListeners.add(listener)
			return () => {
				agentListeners.delete(listener)
			}
		},
		snapshot() {
			return agentSnapshot
		}
	}

	return {
		agent,

		connect,
		refresh: () => loadLocalApps(),

		close() {
			generation++
			closeSocket()
			connectionState = 'disconnected'
			isStreaming = false
			emitAgent()
			loadLocalApps()
		},

		send(frame) {
			if (socket && socket.readyState === SOCKET_OPEN) socket.send(JSON.stringify(frame))
		},

		subscribeApps(listener) {
			appsListeners.add(listener)
			// Replay the current catalog so a late subscriber doesn't miss `ready`.
			listener(apps)
			return () => {
				appsListeners.delete(listener)
			}
		},

		removeApp(id) {
			const next = apps.filter((app) => app.id !== id)
			if (next.length === apps.length) return
			setApps(next)
		},

		onRemoteWindow(handler) {
			remoteWindow = handler
			return () => {
				if (remoteWindow === handler) remoteWindow = null
			}
		}
	}
}
