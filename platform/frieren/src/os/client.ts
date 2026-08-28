import { DEFAULT_AGENT_NAME } from '@justfiles/agent/defaults'
import type { Expression } from '@justfiles/agent/expression'
import type {
	ActivityDetailResult,
	SessionClientMessage,
	SessionServerMessage,
	TranscriptItem,
	TranscriptStatus
} from '@justfiles/agent/protocol'
import type { Notification } from '@justfiles/app/capabilities/notify'
import type { AgentMessage, ConnectionState, TranscriptRow } from '../agent/types'
import type { InstalledApp } from '../apps/types'
import type { OsAction } from './state'

// WebSocket.OPEN; spelled out so the readyState check doesn't depend on the
// browser global being present (tests run under node).
const SOCKET_OPEN = 1

// Backoff for transient control or agent socket drops. Caps at 30s and resets when
// the connection receives its first complete state message.
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
	messages: TranscriptRow[]
	// True from local prompt acceptance through agent_end, including backend setup before the
	// server emits agent_start.
	isStreaming: boolean
	isLoadingHistory: boolean
	// The emotion the agent last tagged, or null until it tags one — and null again once it has
	// been on screen long enough, because calm is not a tag but where the face rests. The last
	// emotion wins, paced so each one is seen (see HOLD_MS). The tags themselves never reach
	// `messages`.
	expression: Expression | null
}

export interface AgentClient {
	connect(): () => void
	prompt(text: string): Promise<boolean>
	abort(): void
	loadActivityDetail(detailId: string): Promise<ActivityDetailResult>
	subscribe(listener: () => void): () => void
	snapshot(): AgentSnapshot
}

export interface FrierenClient {
	connect(): void
	close(): void
	// Re-list installed apps from the local profile volume (e.g. after install).
	refresh(): void
	send(message: object): void
	agent(agentId?: string): AgentClient
	subscribeApps(listener: (apps: InstalledApp[]) => void): () => void
	// Drop an app from the catalog optimistically (uninstall); refresh() is authoritative.
	removeApp(id: string): void
	onRemoteWindow(handler: (action: OsAction) => void): () => void
	// The frieren notification channel: agent/cron notification messages arrive here and
	// are handed to the notification store (mirrors `onRemoteWindow`).
	onNotification(handler: (notification: Notification) => void): () => void
	// The server->client volume poke: a `sync` message says "the server volume changed,
	// pull now" (agent turn, cron, or another device's push). The app wires this to
	// flush the active sync volume. Rides the always-on control socket.
	onSync(handler: () => void): () => void
}

export interface FrierenClientOptions {
	getToken: () => Promise<string | null>
	// Local catalog fallback for offline boot; online `ready` remains authoritative.
	listLocalApps?: () => Promise<InstalledApp[]>
	// Inject the transport for tests.
	createSocket?: (token: string, path: string) => SocketLike
}

type AgentServerMessage =
	| SessionServerMessage
	| { type: 'expression'; expression: Expression | null }
	| { type: 'error'; message: string }
	| { type: 'debug'; message: string }

type ControlServerMessage =
	| {
			type: 'ready'
			participants?: { userName?: string; agentName?: string }
			apps?: unknown
	  }
	| { type: 'error'; message: string }
	| { type: 'app_open'; id: string }
	| { type: 'app_close'; id: string }
	| { type: 'notification'; notification: Notification }
	| { type: 'sync' }

interface SessionView {
	agentId?: string
	socket: SocketLike | null
	generation: number
	users: number
	reconnectTimer: ReturnType<typeof setTimeout> | null
	reconnectAttempts: number
	connectionState: ConnectionState
	messages: TranscriptRow[]
	history: TranscriptItem[]
	status: TranscriptStatus
	submitting: boolean
	loadingHistory: boolean
	pendingPrompt: ((accepted: boolean) => void) | null
	pendingDetails: Map<string, (result: ActivityDetailResult) => void>
	liveId: string | null
	expression: Expression | null
	heldUntil: number
	pending: Expression | null | undefined
	holdTimer: ReturnType<typeof setTimeout> | null
	listeners: Set<() => void>
	snapshot: AgentSnapshot
}

function defaultCreateSocket(token: string, path: string): SocketLike {
	const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
	return new WebSocket(
		`${protocol}//${window.location.host}${path}?token=${encodeURIComponent(token)}`
	) as unknown as SocketLike
}

function agentPath(agentId?: string): string {
	return `/api/agents/${encodeURIComponent(agentId ?? 'main')}/connect`
}

export function createFrierenClient(options: FrierenClientOptions): FrierenClient {
	const createSocket = options.createSocket ?? defaultCreateSocket

	let controlSocket: SocketLike | null = null
	// Bumped on every (re)connect/close so a stale async token resolution from a
	// superseded connect attempt is ignored.
	let controlGeneration = 0
	// Whether the client should hold a connection open — set between connect() and
	// close(). A transient drop reconnects while true; an explicit close clears it.
	let online = false
	let controlReconnectTimer: ReturnType<typeof setTimeout> | null = null
	let controlReconnectAttempts = 0

	// --- agent sessions ---
	let userName = 'You'
	let agentName = DEFAULT_AGENT_NAME
	const agentStates = new Map<string, SessionView>()
	const agentClients = new Map<string, AgentClient>()

	function getAgentState(agentId?: string): SessionView {
		const key = agentId ?? ''
		let state = agentStates.get(key)
		if (state) return state
		state = {
			agentId,
			socket: null,
			generation: 0,
			users: 0,
			reconnectTimer: null,
			reconnectAttempts: 0,
			connectionState: 'disconnected',
			messages: [],
			history: [],
			status: { state: 'idle' },
			submitting: false,
			loadingHistory: false,
			pendingPrompt: null,
			pendingDetails: new Map(),
			liveId: null,
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

	function buildAgentSnapshot(state: SessionView): AgentSnapshot {
		return {
			connectionState: state.connectionState,
			userName,
			agentName,
			messages: state.messages,
			isStreaming: state.submitting || state.status.state !== 'idle',
			isLoadingHistory: state.loadingHistory,
			expression: state.expression
		}
	}

	function emitAgent(state: SessionView): void {
		state.snapshot = buildAgentSnapshot(state)
		for (const listener of state.listeners) listener()
	}

	function emitAgents(): void {
		for (const state of agentStates.values()) emitAgent(state)
	}

	function stopAgentWork(state: SessionView): void {
		state.pendingPrompt?.(false)
		state.pendingPrompt = null
		state.status = { state: 'idle' }
		state.submitting = false
		state.loadingHistory = false
		state.liveId = null
		state.messages = [...state.history]
		for (const resolve of state.pendingDetails.values()) resolve({ status: 'expired' })
		state.pendingDetails.clear()
		emitAgent(state)
	}

	function showStatus(state: SessionView): void {
		if (state.status.state === 'idle') {
			state.liveId = null
			state.messages = [...state.history]
			return
		}
		state.liveId ??= crypto.randomUUID()
		const id = state.liveId
		const temporary: AgentMessage =
			state.status.state === 'responding'
				? { id, role: 'assistant', content: state.status.text }
				: { id, role: 'assistant', content: '', status: state.status.label }
		state.messages = [...state.history, temporary]
	}

	function showExpression(state: SessionView, next: Expression | null): void {
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

	function handleControlMessage(data: ControlServerMessage): void {
		if (data.type === 'ready') {
			controlReconnectAttempts = 0
			if (data.participants) {
				userName = data.participants.userName || 'You'
				agentName = data.participants.agentName || DEFAULT_AGENT_NAME
			}
			emitAgents()
			loadLocalApps(Array.isArray(data.apps) ? (data.apps as InstalledApp[]) : [])
			return
		}
		if (data.type === 'app_open') {
			const title = apps.find((app) => app.id === data.id)?.name
			remoteWindow?.({ type: 'app.open', appId: data.id, title, remote: true })
			return
		}
		if (data.type === 'app_close') {
			remoteWindow?.({ type: 'window.close', id: data.id, remote: true })
			return
		}
		if (data.type === 'notification') {
			notificationSink?.(data.notification)
			return
		}
		if (data.type === 'sync') syncSink?.()
	}

	function handleAgentMessage(data: AgentServerMessage, state: SessionView): void {
		if (data.type === 'expression') {
			showExpression(state, data.expression)
			return
		}
		if (data.type === 'activity_detail') {
			state.pendingDetails.get(data.requestId)?.(data.result)
			state.pendingDetails.delete(data.requestId)
			return
		}
		if (data.type === 'accepted' || data.type === 'rejected') {
			state.pendingPrompt?.(data.type === 'accepted')
			state.pendingPrompt = null
			state.submitting = false
			emitAgent(state)
			return
		}

		if (data.type === 'snapshot') {
			state.reconnectAttempts = 0
			state.connectionState = 'ready'
			state.history = [...data.history]
			state.status = data.status
			state.submitting = false
			state.messages = [...data.history]
			state.loadingHistory = false
			state.liveId = null
			showStatus(state)
			emitAgent(state)
			return
		}

		if (data.type === 'item') {
			state.history = [...state.history, data.item]
			if (state.status.state === 'idle') state.messages = [...state.history]
			else if (data.item.type === 'message' && data.item.role === 'user') showStatus(state)
			emitAgent(state)
			return
		}

		if (data.type === 'status') {
			state.status = data.status
			if (data.status.state === 'idle') {
				state.submitting = false
				showStatus(state)
				if (data.error)
					state.messages.push({
						id: crypto.randomUUID(),
						role: 'assistant',
						content: data.error.message,
						error: true
					})
			} else showStatus(state)
			emitAgent(state)
			return
		}

		// TODO: remove later
		if (data.type === 'debug') {
			state.pendingPrompt?.(false)
			state.pendingPrompt = null
			state.status = { state: 'idle' }
			state.submitting = false
			emitAgent(state)
			console.log(String(data.message ?? ''))
			return
		}
	}

	function attachControl(ws: SocketLike): void {
		ws.onmessage = (event) => {
			if (controlSocket !== ws) return
			let data: ControlServerMessage
			try {
				data = JSON.parse(event.data) as ControlServerMessage
			} catch {
				return
			}
			handleControlMessage(data)
		}
		ws.onclose = () => {
			if (controlSocket !== ws) return
			controlSocket = null
			loadLocalApps()
			scheduleControlReconnect()
		}
		ws.onerror = () => {
			if (controlSocket !== ws) return
			loadLocalApps()
		}
	}

	function closeControlSocket(): void {
		const ws = controlSocket
		controlSocket = null
		ws?.close()
	}

	function scheduleControlReconnect(): void {
		if (!online || controlReconnectTimer) return
		const delay =
			RECONNECT_DELAYS_MS[Math.min(controlReconnectAttempts, RECONNECT_DELAYS_MS.length - 1)]
		controlReconnectAttempts++
		controlReconnectTimer = setTimeout(() => {
			controlReconnectTimer = null
			if (online) openControlSocket()
		}, delay)
	}

	function openControlSocket(): void {
		const gen = ++controlGeneration
		closeControlSocket()
		void (async () => {
			const token = await options.getToken().catch(() => null)
			if (gen !== controlGeneration) return
			if (!token) {
				loadLocalApps()
				scheduleControlReconnect()
				return
			}
			const ws = createSocket(token, '/ws')
			controlSocket = ws
			attachControl(ws)
		})()
	}

	function attachAgent(ws: SocketLike, state: SessionView): void {
		ws.onmessage = (event) => {
			if (state.socket !== ws) return
			let data: AgentServerMessage
			try {
				data = JSON.parse(event.data) as AgentServerMessage
			} catch {
				return
			}
			handleAgentMessage(data, state)
		}
		ws.onclose = () => {
			if (state.socket !== ws) return
			state.socket = null
			state.connectionState = 'disconnected'
			stopAgentWork(state)
			scheduleAgentReconnect(state)
		}
		ws.onerror = () => {
			if (state.socket !== ws) return
			state.connectionState = 'disconnected'
			stopAgentWork(state)
		}
	}

	function closeAgentSocket(state: SessionView): void {
		const ws = state.socket
		state.socket = null
		ws?.close()
	}

	function scheduleAgentReconnect(state: SessionView): void {
		if (!online || state.users === 0 || state.reconnectTimer) return
		const delay =
			RECONNECT_DELAYS_MS[Math.min(state.reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)]
		state.reconnectAttempts++
		state.reconnectTimer = setTimeout(() => {
			state.reconnectTimer = null
			if (online && state.users > 0) openAgentSocket(state)
		}, delay)
	}

	function openAgentSocket(state: SessionView): void {
		const gen = ++state.generation
		closeAgentSocket(state)
		state.connectionState = 'connecting'
		stopAgentWork(state)
		state.loadingHistory = true
		emitAgent(state)
		void (async () => {
			const token = await options.getToken().catch(() => null)
			if (gen !== state.generation) return
			if (!token) {
				state.connectionState = 'disconnected'
				stopAgentWork(state)
				scheduleAgentReconnect(state)
				return
			}
			const ws = createSocket(token, agentPath(state.agentId))
			state.socket = ws
			attachAgent(ws, state)
		})()
	}

	function connectAgent(agentId?: string): () => void {
		const state = getAgentState(agentId)
		state.users++
		if (online && state.connectionState === 'disconnected') {
			state.reconnectAttempts = 0
			openAgentSocket(state)
		}
		return () => {
			state.users--
			if (state.users > 0) return
			if (state.reconnectTimer) clearTimeout(state.reconnectTimer)
			state.reconnectTimer = null
			state.generation++
			closeAgentSocket(state)
			state.connectionState = 'disconnected'
			stopAgentWork(state)
		}
	}

	function connect(): void {
		online = true
		controlReconnectAttempts = 0
		openControlSocket()
		for (const state of agentStates.values()) {
			if (state.users > 0 && state.connectionState === 'disconnected') openAgentSocket(state)
		}
	}

	function getAgentClient(agentId?: string): AgentClient {
		const key = agentId ?? ''
		const cached = agentClients.get(key)
		if (cached) return cached
		const state = getAgentState(agentId)
		const client: AgentClient = {
			connect: () => connectAgent(agentId),
			prompt(text) {
				if (
					!state.socket ||
					state.socket.readyState !== SOCKET_OPEN ||
					state.connectionState !== 'ready'
				)
					return Promise.resolve(false)
				if (state.submitting || state.status.state !== 'idle' || state.loadingHistory)
					return Promise.resolve(false)
				state.submitting = true
				emitAgent(state)
				const accepted = new Promise<boolean>((resolve) => {
					state.pendingPrompt = resolve
				})
				state.socket.send(JSON.stringify({ type: 'prompt', text } satisfies SessionClientMessage))
				return accepted
			},
			abort() {
				if (state.status.state === 'idle') return
				state.socket?.send(JSON.stringify({ type: 'abort' } satisfies SessionClientMessage))
			},
			loadActivityDetail(detailId) {
				if (!state.socket || state.socket.readyState !== SOCKET_OPEN)
					return Promise.resolve({ status: 'expired' })
				const requestId = crypto.randomUUID()
				const result = new Promise<ActivityDetailResult>((resolve) => {
					state.pendingDetails.set(requestId, resolve)
				})
				state.socket.send(
					JSON.stringify({
						type: 'activity_detail',
						requestId,
						detailId
					} satisfies SessionClientMessage)
				)
				return result
			},
			subscribe(listener) {
				state.listeners.add(listener)
				return () => {
					state.listeners.delete(listener)
				}
			},
			snapshot: () => state.snapshot
		}
		agentClients.set(key, client)
		return client
	}

	return {
		agent: getAgentClient,

		connect,
		refresh: () => loadLocalApps(),

		close() {
			online = false
			if (controlReconnectTimer) {
				clearTimeout(controlReconnectTimer)
				controlReconnectTimer = null
			}
			controlGeneration++
			closeControlSocket()
			for (const state of agentStates.values()) {
				if (state.reconnectTimer) clearTimeout(state.reconnectTimer)
				state.reconnectTimer = null
				if (state.holdTimer) clearTimeout(state.holdTimer)
				state.holdTimer = null
				state.generation++
				closeAgentSocket(state)
				state.connectionState = 'disconnected'
				stopAgentWork(state)
			}
			loadLocalApps()
		},

		send(message) {
			if (controlSocket?.readyState === SOCKET_OPEN) controlSocket.send(JSON.stringify(message))
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
