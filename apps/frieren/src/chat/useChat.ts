import { useAuth } from '@clerk/clerk-react'
import type {
	ActiveApp,
	AppRpcError,
	AppRpcRequest,
	AppRpcResponse,
	InstalledApp,
	ToolInvokeHandler,
	ToolResultSender
} from '@justfiles/app'
import { useEffect, useRef, useState } from 'react'
import { createFsVolume } from '../fs'
import type { ChatConnection, ChatMessage, ChatSession, ConnectionState, Launcher } from './types'

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

export interface UseChatResult {
	session: ChatSession
	connection: ChatConnection
	apps: {
		launcher: Launcher
		relay: {
			sendRpc: (frame: AppRpcRequest) => Promise<AppRpcResponse>
			onToolInvoke: (handler: ToolInvokeHandler | null) => void
			sendToolResult: ToolResultSender
			notifyIframeReload: () => void
		}
	}
}

export function useChat(): UseChatResult {
	const { getToken } = useAuth()
	const [messages, setMessages] = useState<ChatMessage[]>([])
	const [input, setInput] = useState('')
	const [userName, setUserName] = useState('You')
	const [agentName, setAgentName] = useState('Frieren')
	const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected')
	const [isStreaming, setIsStreaming] = useState(false)
	const [connectKey, setConnectKey] = useState(0)
	const [activeApp, setActiveApp] = useState<ActiveApp | null>(null)
	const [installedApps, setInstalledApps] = useState<InstalledApp[]>([])

	const wsRef = useRef<WebSocket | null>(null)
	const currentAssistantIdRef = useRef<string | null>(null)
	const getTokenRef = useRef(getToken)
	getTokenRef.current = getToken
	// Pending app-RPC requests keyed by frame id. The iframe minted the id;
	// the worker echoes it back on `app_rpc` so we can resolve here.
	const pendingRpcRef = useRef(new Map<string, (frame: AppRpcResponse) => void>())
	// Handler registered by AppFrame to receive server-originated tool invocations.
	const toolInvokeHandlerRef = useRef<ToolInvokeHandler | null>(null)

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
					setActiveApp({ kind: 'sandbox', id: data.id, ui: data.ui })
					return
				}

				if (data.type === 'app_close') {
					setActiveApp(null)
					return
				}

				if (data.type === 'app_rpc' && data.frame) {
					const frame = data.frame as AppRpcResponse
					const resolver = pendingRpcRef.current.get(String(frame.id))
					if (!resolver) return
					pendingRpcRef.current.delete(String(frame.id))
					resolver(frame)
					return
				}

				if (data.type === 'app_tool_invoke' && data.callId && data.name) {
					toolInvokeHandlerRef.current?.(
						String(data.callId),
						String(data.name),
						data.input as unknown
					)
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

	const sendRpc = (frame: AppRpcRequest): Promise<AppRpcResponse> =>
		new Promise<AppRpcResponse>((resolve) => {
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
		if (app.kind === 'esm') {
			if (!app.manifestUrl || !app.baseUrl) return
			setActiveApp({
				kind: 'esm',
				id: app.id,
				manifestUrl: app.manifestUrl,
				baseUrl: app.baseUrl
			})
			return
		}
		if (app.kind === 'kernel') {
			setActiveApp({ kind: 'kernel', id: app.id })
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

	// Dev install: prompt the user for a directory containing a kernel-app
	// bundle (manifest.json + app.js + gui.js), copy the bytes into the
	// per-user Volume at /kernel/applications/<id>, then reconnect so the
	// launcher's `ready` payload re-lists installed apps.
	const installKernelApp = async () => {
		const picker = (
			window as unknown as { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> }
		).showDirectoryPicker
		if (!picker) {
			alert('Directory picker not supported in this browser (use Chrome or Edge).')
			return
		}
		let dir: FileSystemDirectoryHandle
		try {
			dir = await picker()
		} catch (e) {
			if (e instanceof DOMException && e.name === 'AbortError') return
			throw e
		}
		try {
			const manifestFile = await (await dir.getFileHandle('manifest.json')).getFile()
			const manifest = JSON.parse(await manifestFile.text()) as { id?: string }
			if (!manifest.id) throw new Error('manifest.json is missing "id"')
			const vol = await createFsVolume(() => getTokenRef.current())
			const root = `/kernel/applications/${manifest.id}`
			await vol.mkdir(root, { recursive: true })
			for await (const [name, handle] of (
				dir as unknown as {
					entries(): AsyncIterable<[string, FileSystemHandle]>
				}
			).entries()) {
				if (handle.kind !== 'file') continue
				const file = await (handle as FileSystemFileHandle).getFile()
				const bytes = new Uint8Array(await file.arrayBuffer())
				await vol.writeFile(`${root}/${name}`, bytes)
			}
			reconnect()
		} catch (e) {
			alert(`Install failed: ${e instanceof Error ? e.message : String(e)}`)
		}
	}

	const onToolInvoke = (handler: ToolInvokeHandler | null) => {
		toolInvokeHandlerRef.current = handler
	}

	const sendToolResult: ToolResultSender = (callId, result, error?: AppRpcError) => {
		wsRef.current?.send(JSON.stringify({ type: 'app_tool_result', callId, result, error }))
	}

	const notifyIframeReload = () => {
		wsRef.current?.send(JSON.stringify({ type: 'app_iframe_reload' }))
	}

	return {
		session: { messages, input, setInput, userName, agentName, isStreaming, sendMessage, abort },
		connection: { state: connectionState, reconnect },
		apps: {
			launcher: {
				activeApp,
				installedApps,
				launch: launchApp,
				close: closeApp,
				installKernelApp
			},
			relay: { sendRpc, onToolInvoke, sendToolResult, notifyIframeReload }
		}
	}
}
