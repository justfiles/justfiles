import { createExpressionParser, type Expression } from '@justfiles/agent/expression'
import type { Notification } from '@justfiles/app/capabilities/notify'
import type { TranscriptImage } from '@justfiles/ui/Transcript'
import type { AgentMessage, ConnectionState } from '../agent/types'
import type { InstalledApp } from '../apps/types'
import type { OsAction } from './state'

// WebSocket.OPEN; spelled out so the readyState check doesn't depend on the
// browser global being present (tests run under node).
const SOCKET_OPEN = 1

// Backoff for transient `/ws` drops. `/ws` is the always-on session socket and the
// sole proactive sync-poke channel, so it must self-heal (the removed `_caps` path
// reconnected on next use). Caps at 30s; reset on a healthy `ready`.
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 15_000, 30_000] as const

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
	// The last expression tag the agent emitted (null until it tags one). Last tag wins: a
	// reply that tags several sentences ends on its final one. The tags themselves never
	// reach `messages`.
	expression: Expression | null
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
	// The frieren notification channel: agent/cron notification frames arrive here and
	// are handed to the notification store (mirrors `onRemoteWindow`).
	onNotification(handler: (notification: Notification) => void): () => void
	// The server->client volume poke: a `sync` frame says "the server volume changed,
	// pull now" (agent turn, cron, or another device's push). The app wires this to
	// flush the active sync volume. Rides the always-on session socket.
	onSync(handler: () => void): () => void
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
	toolCalls?: {
		name: string
		args: unknown
		result?: unknown
		isError?: boolean
		images?: TranscriptImage[]
	}[]
}

// Image refs ride out-of-band on a tool result's `details` (see #194); pull them
// onto the tool call so the transcript can promote them to inline cards.
function imagesFromResult(result: unknown): TranscriptImage[] | undefined {
	const images = (result as { details?: { images?: TranscriptImage[] } } | undefined)?.details
		?.images
	return Array.isArray(images) && images.length > 0 ? images : undefined
}

interface ServerFrame {
	type?: string
	participants?: { userName?: string; agentName?: string }
	apps?: unknown
	messages?: HistoryMessage[]
	message?: string
	id?: string
	event?: AgentEventFrame
	notification?: Notification
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
	// Whether the client should hold a connection open — set between connect() and
	// close(). A transient drop reconnects while true; an explicit close clears it.
	let wantConnection = false
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null
	let reconnectAttempts = 0

	// --- agent session (BehaviorSubject) ---
	let connectionState: ConnectionState = 'disconnected'
	let userName = 'You'
	let agentName = 'Kodama'
	let messages: AgentMessage[] = []
	let isStreaming = false
	let currentAssistantId: string | null = null
	// Per-message tag stripper: a tag can straddle two token deltas, so the leftover is
	// held inside the parser until the next delta (or `flush` at end of message).
	let expressionParser = createExpressionParser()
	let expression: Expression | null = null
	const agentListeners = new Set<() => void>()
	let agentSnapshot: AgentSnapshot = buildAgentSnapshot()

	function buildAgentSnapshot(): AgentSnapshot {
		return { connectionState, userName, agentName, messages, isStreaming, expression }
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

	// --- server-pushed notifications (agent / cron) ---
	let notificationSink: ((notification: Notification) => void) | null = null

	// --- server-pushed volume poke (pull now) ---
	let syncSink: (() => void) | null = null

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
					expressionParser = createExpressionParser()
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
					const { text, expression: tagged } = expressionParser.push(delta.delta)
					if (tagged) expression = tagged
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

			case 'message_end': {
				const id = currentAssistantId
				if (!id) break
				// Whatever the parser is still holding was never a tag — render it.
				const rest = expressionParser.flush()
				if (rest)
					mapMessages((message) =>
						message.id === id ? { ...message, content: message.content + rest } : message
					)
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
												status: 'done' as const,
												images: imagesFromResult(event.result)
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
			reconnectAttempts = 0
			if (data.participants) {
				userName = data.participants.userName || 'You'
				agentName = data.participants.agentName || 'Kodama'
			}
			connectionState = 'ready'
			emitAgent()
			loadLocalApps(Array.isArray(data.apps) ? (data.apps as InstalledApp[]) : [])
			return
		}

		if (data.type === 'history') {
			if (data.participants) {
				userName = data.participants.userName || 'You'
				agentName = data.participants.agentName || 'Kodama'
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
					status: 'done' as const,
					images: tc.images
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

		if (data.type === 'notification' && data.notification) {
			notificationSink?.(data.notification)
			return
		}

		if (data.type === 'sync') {
			syncSink?.()
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
			scheduleReconnect()
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

	// Re-open after a transient drop, backing off. A no-op once an explicit close
	// cleared `wantConnection` or while an attempt is already scheduled.
	function scheduleReconnect(): void {
		if (!wantConnection || reconnectTimer) return
		const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)]
		reconnectAttempts++
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null
			if (wantConnection) openSocket()
		}, delay)
	}

	function openSocket(): void {
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
				scheduleReconnect()
				return
			}
			const ws = createSocket(token)
			socket = ws
			attach(ws)
		})()
	}

	function connect(): void {
		wantConnection = true
		reconnectAttempts = 0
		openSocket()
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
			wantConnection = false
			if (reconnectTimer) {
				clearTimeout(reconnectTimer)
				reconnectTimer = null
			}
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
		},

		onNotification(handler) {
			notificationSink = handler
			return () => {
				if (notificationSink === handler) notificationSink = null
			}
		},

		onSync(handler) {
			syncSink = handler
			return () => {
				if (syncSink === handler) syncSink = null
			}
		}
	}
}
