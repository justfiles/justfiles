import { useAuth } from '@clerk/clerk-react'
import { useEffect, useRef, useState } from 'react'
import type {
	ActiveApp,
	AppAction,
	AppRpcFrame,
	ChatMessage,
	ConnectionState,
	InstalledApp
} from './types'

interface AgentEvent {
	type: string
	message?: { role: string }
	assistantMessageEvent?: { type: string; delta?: string }
	toolCallId?: string
	toolName?: string
	args?: unknown
	result?: unknown
	isError?: boolean
}

export function useChat() {
	const { getToken } = useAuth()
	const [messages, setMessages] = useState<ChatMessage[]>([])
	const [input, setInput] = useState('')
	const [userName, setUserName] = useState('You')
	const [agentName, setAgentName] = useState('Frieren')
	const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected')
	const [isStreaming, setIsStreaming] = useState(false)
	const [connectKey, setConnectKey] = useState(0)
	const [activeApp, setActiveApp] = useState<ActiveApp>(null)
	const [installedApps, setInstalledApps] = useState<InstalledApp[]>([])

	const wsRef = useRef<WebSocket | null>(null)
	const currentAssistantIdRef = useRef<string | null>(null)
	const getTokenRef = useRef(getToken)
	getTokenRef.current = getToken
	// Pending app-RPC requests keyed by frame id. The iframe minted the id;
	// the worker echoes it back on `app_rpc` so we can resolve here.
	const pendingRpcRef = useRef(new Map<string, (frame: AppRpcFrame) => void>())

	useEffect(() => {
		void connectKey

		const handleAgentEvent = (event: AgentEvent) => {
			switch (event.type) {
				case 'agent_start':
					setIsStreaming(true)
					break

				case 'agent_end':
					setIsStreaming(false)
					currentAssistantIdRef.current = null
					break

				case 'message_start': {
					if (event.message?.role === 'assistant') {
						const id = crypto.randomUUID()
						currentAssistantIdRef.current = id
						setMessages((prev) => [
							...prev,
							{ id, role: 'assistant', content: '', thinking: '', toolCalls: [] }
						])
					}
					break
				}

				case 'message_update': {
					const assistantEvent = event.assistantMessageEvent
					if (assistantEvent?.type === 'text_delta' && assistantEvent.delta) {
						const currentId = currentAssistantIdRef.current
						if (!currentId) break
						setMessages((prev) =>
							prev.map((message) =>
								message.id === currentId
									? { ...message, content: message.content + assistantEvent.delta }
									: message
							)
						)
					}
					if (assistantEvent?.type === 'thinking_delta' && assistantEvent.delta) {
						const currentId = currentAssistantIdRef.current
						if (!currentId) break
						setMessages((prev) =>
							prev.map((message) =>
								message.id === currentId
									? { ...message, thinking: (message.thinking ?? '') + assistantEvent.delta }
									: message
							)
						)
					}
					break
				}

				case 'tool_execution_start': {
					const currentId = currentAssistantIdRef.current
					if (!currentId || !event.toolCallId || !event.toolName) break
					const toolCallId = event.toolCallId
					const toolName = event.toolName
					setMessages((prev) =>
						prev.map((message) =>
							message.id === currentId
								? {
										...message,
										toolCalls: [
											...(message.toolCalls ?? []),
											{
												id: toolCallId,
												name: toolName,
												args: event.args,
												status: 'running' as const
											}
										]
									}
								: message
						)
					)
					break
				}

				case 'tool_execution_end': {
					const currentId = currentAssistantIdRef.current
					if (!currentId) break
					setMessages((prev) =>
						prev.map((message) =>
							message.id === currentId
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
					)
					break
				}
			}
		}

		let ws: WebSocket | null = null
		let cancelled = false
		setConnectionState('connecting')

		const connect = async () => {
			const token = await getTokenRef.current().catch(() => null)
			if (cancelled) return
			if (!token) {
				setConnectionState('disconnected')
				return
			}

			const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
			ws = new WebSocket(
				`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`
			)
			wsRef.current = ws
			attachHandlers(ws)
		}

		const attachHandlers = (socket: WebSocket) => {
			socket.onmessage = (event) => {
				const data = JSON.parse(event.data)

				if (data.type === 'ready') {
					if (data.participants) {
						setUserName(data.participants.userName || 'You')
						setAgentName(data.participants.agentName || 'Frieren')
					}
					setInstalledApps(Array.isArray(data.apps) ? data.apps : [])
					setConnectionState('ready')
					return
				}

				if (data.type === 'history') {
					if (data.participants) {
						setUserName(data.participants.userName || 'You')
						setAgentName(data.participants.agentName || 'Frieren')
					}
					const restored: ChatMessage[] = (data.messages ?? []).map(
						(m: {
							role: string
							content: string
							source?: 'user' | 'app'
							thinking?: string
							toolCalls?: { name: string; args: unknown; result?: unknown; isError?: boolean }[]
						}) => ({
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
						})
					)
					if (restored.length > 0) setMessages(restored)
					return
				}

				if (data.type === 'app_prompt') {
					setMessages((prev) => [
						...prev,
						{
							id: crypto.randomUUID(),
							role: 'user',
							source: 'app',
							content: String(data.text ?? '')
						}
					])
					return
				}

				if (data.type === 'error') {
					console.error('Server error:', data.message)
					setIsStreaming(false)
					return
				}

				// TODO: remove later
				if (data.type === 'debug') {
					console.log(String(data.message ?? ''))
					return
				}

				if (data.type === 'app_open') {
					setActiveApp({ kind: 'sandbox', id: data.id, ui: data.ui, state: data.state })
					return
				}

				if (data.type === 'app_state') {
					setActiveApp((prev) =>
						prev && prev.kind === 'sandbox' ? { ...prev, state: data.state } : prev
					)
					return
				}

				if (data.type === 'app_close') {
					setActiveApp(null)
					return
				}

				if (data.type === 'app_rpc' && data.frame) {
					const frame = data.frame as AppRpcFrame
					const resolver = pendingRpcRef.current.get(String(frame.id))
					if (!resolver) return
					pendingRpcRef.current.delete(String(frame.id))
					resolver(frame)
					return
				}

				if (data.type === 'event') handleAgentEvent(data.event)
			}

			socket.onclose = () => {
				if (wsRef.current === socket) {
					setConnectionState('disconnected')
					setIsStreaming(false)
					wsRef.current = null
					for (const [id, resolve] of pendingRpcRef.current) {
						resolve({
							jsonrpc: '2.0',
							id,
							error: { code: -32004, message: 'connection_closed' }
						})
					}
					pendingRpcRef.current.clear()
				}
			}

			socket.onerror = () => {
				if (wsRef.current === socket) {
					setConnectionState('disconnected')
					setIsStreaming(false)
				}
			}
		}

		void connect()

		return () => {
			cancelled = true
			ws?.close()
		}
	}, [connectKey])

	const sendMessage = () => {
		const text = input.trim()
		if (!text || !wsRef.current || connectionState !== 'ready') return

		const userMessage: ChatMessage = {
			id: crypto.randomUUID(),
			role: 'user',
			content: text
		}

		setMessages((prev) => [...prev, userMessage])
		setInput('')
		wsRef.current.send(JSON.stringify({ type: 'prompt', text }))
	}

	const abort = () => {
		wsRef.current?.send(JSON.stringify({ type: 'abort' }))
	}

	// LEGACY (state-machine; removed with #76). Client-only apps go through
	// `sendAppRpc` below.
	const sendAppAction = (action: AppAction) => {
		if (!wsRef.current || connectionState !== 'ready') return
		wsRef.current.send(JSON.stringify({ type: 'app_action', action }))
	}

	const sendAppRpc = (frame: AppRpcFrame): Promise<AppRpcFrame> =>
		new Promise<AppRpcFrame>((resolve) => {
			const ws = wsRef.current
			const id = String(frame.id)
			if (!ws || connectionState !== 'ready') {
				resolve({ jsonrpc: '2.0', id, error: { code: -32004, message: 'no_connection' } })
				return
			}
			pendingRpcRef.current.set(id, resolve)
			ws.send(JSON.stringify({ type: 'app_rpc', frame }))
		})

	const launchApp = (app: InstalledApp) => {
		if (app.kind === 'builtin') {
			setActiveApp({ kind: 'builtin', id: app.id })
			return
		}
		if (!wsRef.current || connectionState !== 'ready') return
		wsRef.current.send(JSON.stringify({ type: 'app_launch', id: app.id }))
	}

	const closeApp = () => {
		setActiveApp((prev) => {
			if (prev?.kind === 'sandbox' && wsRef.current && connectionState === 'ready') {
				wsRef.current.send(JSON.stringify({ type: 'app_close' }))
			}
			return null
		})
	}

	const reconnect = () => setConnectKey((value) => value + 1)

	return {
		messages,
		input,
		setInput,
		userName,
		agentName,
		connectionState,
		isStreaming,
		sendMessage,
		abort,
		reconnect,
		activeApp,
		installedApps,
		launchApp,
		closeApp,
		sendAppAction,
		sendAppRpc
	}
}
