import { DEFAULT_AGENT_NAME } from '@justfiles/agent/defaults'
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

// Expression pacing. An emotion earns a minimum time on screen: tags arrive far faster than a
// face can be read — two sentences of a reply can land inside the same second — so a
// replacement waits its turn. Only the NEWEST waiting emotion is kept: a beat nobody saw is
// not worth a queue. Nothing is ever shown for less than this, a turn boundary included, which
// is what stops a quick follow-up prompt from wiping a face the user never registered.
//
// This is the floor. The cap at the other end — how long a held emotion survives the silence
// after a reply — is the avatar's REST_DELAY_MS.
const HOLD_MS = 3_000

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
	isLoadingHistory: boolean
	// The emotion the agent last tagged, or null until it tags one — and null again once it has
	// been on screen long enough, because calm is not a tag but where the face rests. The last
	// emotion wins, paced so each one is seen (see HOLD_MS). The tags themselves never reach
	// `messages`.
	expression: Expression | null
}

export interface AgentClient {
	prompt(text: string, agentId?: string): void
	abort(agentId?: string): void
	loadHistory(agentId?: string): void
	subscribe(listener: () => void, agentId?: string): () => void
	snapshot(agentId?: string): AgentSnapshot
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
	agentId?: string
	participants?: { userName?: string; agentName?: string }
	apps?: unknown
	messages?: HistoryMessage[]
	message?: string
	id?: string
	event?: AgentEventFrame
	notification?: Notification
}

interface AgentState {
	messages: AgentMessage[]
	isStreaming: boolean
	isLoadingHistory: boolean
	currentAssistantId: string | null
	expressionParser: ReturnType<typeof createExpressionParser>
	expression: Expression | null
	heldUntil: number
	pending: Expression | null | undefined
	holdTimer: ReturnType<typeof setTimeout> | null
	listeners: Set<() => void>
	snapshot: AgentSnapshot
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

	// --- agent sessions (one keyed state block over one socket) ---
	let connectionState: ConnectionState = 'disconnected'
	let userName = 'You'
	let agentName = DEFAULT_AGENT_NAME
	const agentStates = new Map<string, AgentState>()

	function getAgentState(agentId?: string): AgentState {
		const key = agentId ?? ''
		let state = agentStates.get(key)
		if (state) return state
		state = {
			messages: [],
			isStreaming: false,
			isLoadingHistory: false,
			currentAssistantId: null,
			expressionParser: createExpressionParser(),
			expression: null,
			heldUntil: 0,
			pending: undefined,
			holdTimer: null,
			listeners: new Set(),
			snapshot: {} as AgentSnapshot
		}
		state.snapshot = buildAgentSnapshot(state)
		agentStates.set(key, state)
		return state
	}

	function buildAgentSnapshot(state: AgentState): AgentSnapshot {
		return {
			connectionState,
			userName,
			agentName,
			messages: state.messages,
			isStreaming: state.isStreaming,
			isLoadingHistory: state.isLoadingHistory,
			expression: state.expression
		}
	}

	function emitAgent(state: AgentState): void {
		state.snapshot = buildAgentSnapshot(state)
		for (const listener of state.listeners) listener()
	}

	function emitAgents(): void {
		for (const state of agentStates.values()) emitAgent(state)
	}

	function stopAgentWork(): void {
		for (const state of agentStates.values()) {
			state.isStreaming = false
			state.isLoadingHistory = false
		}
		emitAgents()
	}

	function setMessages(state: AgentState, next: AgentMessage[]): void {
		state.messages = next
		emitAgent(state)
	}

	function mapMessages(state: AgentState, fn: (message: AgentMessage) => AgentMessage): void {
		setMessages(state, state.messages.map(fn))
	}

	function showExpression(state: AgentState, next: Expression | null): void {
		if (next === state.expression && state.pending === undefined) return
		const wait = state.heldUntil - Date.now()
		if (wait > 0) {
			state.pending = next
			if (!state.holdTimer) {
				state.holdTimer = setTimeout(() => {
					state.holdTimer = null
					const waiting = state.pending
					state.pending = undefined
					if (waiting !== undefined) showExpression(state, waiting)
				}, wait)
			}
			return
		}
		state.pending = undefined
		state.expression = next
		state.heldUntil = next ? Date.now() + HOLD_MS : 0
		emitAgent(state)
	}

	getAgentState()

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

	function handleAgentEvent(event: AgentEventFrame, agentId?: string): void {
		const state = getAgentState(agentId)
		switch (event.type) {
			case 'agent_start':
				// A new turn starts from a clean face. This has to happen HERE, not at the first
				// assistant message: `isStreaming` flips on now, which un-rests the avatar, and the
				// model's first token is a second or more away — long enough to flash the previous
				// reply's emotion. "Omit the tag to continue" holds WITHIN a turn (across tool
				// calls), never across turns. Going through `showExpression` is what keeps the
				// previous emotion from being cut short by an eager follow-up prompt: it rests now if
				// the minimum has been served, and as soon as it has otherwise.
				showExpression(state, null)
				state.isStreaming = true
				emitAgent(state)
				break

			case 'agent_end':
				state.isStreaming = false
				state.currentAssistantId = null
				emitAgent(state)
				break

			case 'message_start': {
				if (event.message?.role === 'assistant') {
					const id = crypto.randomUUID()
					state.currentAssistantId = id
					state.expressionParser = createExpressionParser()
					setMessages(state, [
						...state.messages,
						{ id, role: 'assistant', content: '', thinking: '', toolCalls: [] }
					])
				}
				break
			}

			case 'message_update': {
				const id = state.currentAssistantId
				if (!id) break
				const delta = event.assistantMessageEvent
				if (delta?.type === 'text_delta' && delta.delta) {
					const { text, expression: tagged } = state.expressionParser.push(delta.delta)
					// Only emotions can reach here: there is no tag for calm, because calm is where the
					// face rests rather than something the agent claims.
					if (tagged) showExpression(state, tagged)
					mapMessages(state, (message) =>
						message.id === id ? { ...message, content: message.content + text } : message
					)
				}
				if (delta?.type === 'thinking_delta' && delta.delta) {
					const text = delta.delta
					mapMessages(state, (message) =>
						message.id === id ? { ...message, thinking: (message.thinking ?? '') + text } : message
					)
				}
				break
			}

			case 'message_end': {
				const id = state.currentAssistantId
				if (!id) break
				// Whatever the parser is still holding was never a tag — render it.
				const rest = state.expressionParser.flush()
				if (rest)
					mapMessages(state, (message) =>
						message.id === id ? { ...message, content: message.content + rest } : message
					)
				break
			}

			case 'tool_execution_start': {
				const id = state.currentAssistantId
				if (!id || !event.toolCallId || !event.toolName) break
				const toolCallId = event.toolCallId
				const toolName = event.toolName
				mapMessages(state, (message) =>
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
				const id = state.currentAssistantId
				if (!id) break
				mapMessages(state, (message) =>
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
				agentName = data.participants.agentName || DEFAULT_AGENT_NAME
			}
			connectionState = 'ready'
			emitAgents()
			loadLocalApps(Array.isArray(data.apps) ? (data.apps as InstalledApp[]) : [])
			return
		}

		if (data.type === 'history') {
			const state = getAgentState(data.agentId)
			if (data.participants) {
				userName = data.participants.userName || 'You'
				agentName = data.participants.agentName || DEFAULT_AGENT_NAME
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
			state.messages = restored
			state.isLoadingHistory = false
			emitAgents()
			return
		}

		if (data.type === 'error') {
			const state = getAgentState(data.agentId)
			console.error('Server error:', data.message)
			state.isStreaming = false
			// Surface the failure in the transcript (an error-styled block), not just the
			// console — e.g. "turn on an AI provider in Settings" when no AI is enabled.
			const body = typeof data.message === 'string' ? data.message : 'Something went wrong.'
			setMessages(state, [
				...state.messages,
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

		if (data.type === 'event' && data.event) handleAgentEvent(data.event, data.agentId)
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
			stopAgentWork()
			loadLocalApps()
			scheduleReconnect()
		}
		ws.onerror = () => {
			if (socket !== ws) return
			connectionState = 'disconnected'
			stopAgentWork()
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
		stopAgentWork()
		void (async () => {
			const token = await options.getToken().catch(() => null)
			if (gen !== generation) return
			if (!token) {
				connectionState = 'disconnected'
				emitAgents()
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
		prompt(text, agentId) {
			if (!socket || socket.readyState !== SOCKET_OPEN || connectionState !== 'ready') return
			const state = getAgentState(agentId)
			setMessages(state, [
				...state.messages,
				{ id: crypto.randomUUID(), role: 'user', content: text }
			])
			socket.send(JSON.stringify({ type: 'prompt', text, ...(agentId ? { agentId } : {}) }))
		},
		abort(agentId) {
			socket?.send(JSON.stringify({ type: 'abort', ...(agentId ? { agentId } : {}) }))
		},
		loadHistory(agentId) {
			if (!socket || socket.readyState !== SOCKET_OPEN || connectionState !== 'ready') return
			const state = getAgentState(agentId)
			if (state.isLoadingHistory) return
			state.isLoadingHistory = true
			emitAgent(state)
			socket.send(JSON.stringify({ type: 'history', ...(agentId ? { agentId } : {}) }))
		},
		subscribe(listener, agentId) {
			const state = getAgentState(agentId)
			state.listeners.add(listener)
			return () => {
				state.listeners.delete(listener)
			}
		},
		snapshot(agentId) {
			return getAgentState(agentId).snapshot
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
			for (const state of agentStates.values()) {
				if (state.holdTimer) clearTimeout(state.holdTimer)
				state.holdTimer = null
			}
			generation++
			closeSocket()
			connectionState = 'disconnected'
			stopAgentWork()
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
