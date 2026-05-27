import { useAuth } from '@clerk/clerk-react'
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import * as kernelAppHost from '../kernelAppHost'
import type {
	ActiveApp,
	ChatConnection,
	ChatMessage,
	ChatSession,
	ConnectionState,
	InstalledApp,
	Launcher
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

function pickZipFile(): Promise<File | null> {
	return new Promise((resolve) => {
		const input = document.createElement('input')
		input.type = 'file'
		input.accept = '.zip,application/zip'
		input.onchange = () => resolve(input.files?.[0] ?? null)
		input.click()
	})
}

function bringToFront(stack: string[], id: string): string[] {
	if (stack[stack.length - 1] === id) return stack
	return [...stack.filter((x) => x !== id), id]
}

async function responseError(res: Response): Promise<string> {
	try {
		const body = (await res.json()) as { error?: unknown }
		if (typeof body.error === 'string') return body.error
	} catch {}
	return `${res.status} ${res.statusText}`
}

export interface UseChatResult {
	session: ChatSession
	connection: ChatConnection
	apps: {
		launcher: Launcher
	}
}

const ChatContext = createContext<UseChatResult | null>(null)

export const ChatProvider = ChatContext.Provider

export function useChatSession(): UseChatResult {
	const value = useContext(ChatContext)
	if (!value) throw new Error('useChatSession must be used inside <ChatProvider>')
	return value
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
	// `openApps` is the running set in stable INSERTION order — never reorder
	// it on focus. React unmounts/remounts the matching child even with
	// stable keys when the children array reorders; the guest GUI now lives
	// behind kernelAppHost so its DOM survives, but mount/unmount churn is
	// still wasteful and leaks WS reconnects. Focus lives separately in
	// `focusStack`; the last element is the focused id.
	const [openApps, setOpenApps] = useState<ActiveApp[]>([])
	const [focusStack, setFocusStack] = useState<string[]>([])
	const [installedApps, setInstalledApps] = useState<InstalledApp[]>([])

	const wsRef = useRef<WebSocket | null>(null)
	const currentAssistantIdRef = useRef<string | null>(null)
	const getTokenRef = useRef(getToken)
	getTokenRef.current = getToken
	// Snapshot of installedApps for the WS handler closure, which captures
	// state at attach time. Used to resolve guiUrl on agent-initiated opens.
	const installedAppsRef = useRef<InstalledApp[]>([])
	installedAppsRef.current = installedApps
	const installingAppRef = useRef(false)

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

				if (data.type === 'kernel_app_open') {
					const id = data.id as string
					const info = installedAppsRef.current.find((a) => a.id === id)
					kernelAppHost.open(id, {
						guiUrl: info?.guiUrl,
						getToken: () => getTokenRef.current()
					})
					setOpenApps((prev) => (prev.some((a) => a.id === id) ? prev : [...prev, { id }]))
					setFocusStack((prev) => bringToFront(prev, id))
					return
				}

				if (data.type === 'kernel_app_close') {
					setOpenApps((prev) => prev.filter((a) => a.id !== data.id))
					setFocusStack((prev) => prev.filter((x) => x !== data.id))
					kernelAppHost.close(data.id as string)
					return
				}

				if (data.type === 'event') handleAgentEvent(data.event)
			}

			socket.onclose = () => {
				if (wsRef.current === socket) {
					setConnectionState('disconnected')
					setIsStreaming(false)
					wsRef.current = null
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

	const launchApp = (app: InstalledApp) => {
		kernelAppHost.open(app.id, {
			guiUrl: app.guiUrl,
			getToken: () => getTokenRef.current()
		})
		setOpenApps((prev) => (prev.some((a) => a.id === app.id) ? prev : [...prev, { id: app.id }]))
		setFocusStack((prev) => bringToFront(prev, app.id))
		wsRef.current?.send(JSON.stringify({ type: 'kernel_app_open', id: app.id }))
	}

	const closeApp = () => {
		const id = focusStack[focusStack.length - 1]
		if (!id) return
		setOpenApps((prev) => prev.filter((a) => a.id !== id))
		setFocusStack((prev) => prev.filter((x) => x !== id))
		kernelAppHost.close(id)
		wsRef.current?.send(JSON.stringify({ type: 'kernel_app_close', id }))
	}

	const focusApp = (app: ActiveApp) => {
		setFocusStack((prev) => bringToFront(prev, app.id))
	}

	const reconnect = () => setConnectKey((value) => value + 1)

	// Dev install: prompt the user for a zipped kernel-app bundle, upload it to
	// the kernel install endpoint, then reconnect so the launcher re-lists apps.
	const installApp = async () => {
		if (installingAppRef.current) return
		installingAppRef.current = true
		try {
			await installAppOnce()
		} finally {
			installingAppRef.current = false
		}
	}

	const installAppOnce = async () => {
		const zip = await pickZipFile()
		if (!zip) return
		try {
			const form = new FormData()
			form.append('bundle', zip)
			const res = await fetch('/api/apps/install', {
				method: 'POST',
				headers: { authorization: `Bearer ${await getTokenRef.current()}` },
				body: form
			})
			if (!res.ok) throw new Error(await responseError(res))
			reconnect()
		} catch (e) {
			alert(`Install failed: ${e instanceof Error ? e.message : String(e)}`)
		}
	}

	// Delete an app-system bundle through the app lifecycle endpoint and drop
	// it from the launcher state optimistically. Mirror of `installApp`.
	const uninstallApp = async (id: string) => {
		const prev = installedApps
		// Close any open window for this app first. Otherwise the still-mounted
		// KernelAppFrame sees its `guiUrl` go undefined when the launcher drops
		// the app, the effect re-fires, and the GUI's React root is unmounted
		// synchronously from inside the parent's commit — corrupting the DOM
		// (NotFoundError on removeChild) and leaving the desktop in a half-
		// broken state where the user sees "nothing happens".
		setOpenApps((open) => open.filter((a) => a.id !== id))
		setFocusStack((stack) => stack.filter((x) => x !== id))
		kernelAppHost.close(id)
		wsRef.current?.send(JSON.stringify({ type: 'kernel_app_close', id }))
		setInstalledApps((apps) => apps.filter((a) => a.id !== id))
		try {
			const res = await fetch(`/api/apps/${encodeURIComponent(id)}`, {
				method: 'DELETE',
				headers: { authorization: `Bearer ${await getTokenRef.current()}` }
			})
			if (!res.ok) throw new Error(await responseError(res))
		} catch (e) {
			setInstalledApps(prev)
			alert(`Uninstall failed: ${e instanceof Error ? e.message : String(e)}`)
		}
	}

	const focusedId = focusStack[focusStack.length - 1] ?? null
	const activeApp = focusedId ? (openApps.find((a) => a.id === focusedId) ?? null) : null

	return {
		session: { messages, input, setInput, userName, agentName, isStreaming, sendMessage, abort },
		connection: { state: connectionState, reconnect },
		apps: {
			launcher: {
				openApps,
				focusStack,
				focusedId,
				activeApp,
				installedApps,
				launch: launchApp,
				close: closeApp,
				focus: focusApp,
				installApp,
				uninstallApp
			}
		}
	}
}
