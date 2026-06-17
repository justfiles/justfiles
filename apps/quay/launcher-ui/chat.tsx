// The launcher's chat surface: a tiny React entry quayd serves at /launcher/chat
// and the native launcher embeds in a transparent WKWebView. It renders the shared
// @justfiles/ui <Transcript/> over quay's privileged JSON ws socket (the same
// catalog/agent channel launcher.js uses) and exposes the native bridge:
// window.quaySend / window.quayAbort for input, webkit.messageHandlers.status for
// streaming + connection state. The native composer owns input; this view is
// display-only. The agent is request/response (server.ts), so a turn shows an
// optimistic user bubble + a streaming-caret placeholder until the authoritative
// transcript returns.

import { type AgentMessage, Transcript } from '@justfiles/ui/Transcript'
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

type ConnectionState = 'connecting' | 'ready' | 'disconnected'

// The native bridge surface (set by Launcher.swift's WKWebView) and the shell-
// injected token. Declared narrowly so we never reach for `any`.
interface QuayChatWindow {
	__quayChat?: { token?: string }
	webkit?: { messageHandlers?: { status?: { postMessage(message: unknown): void } } }
	quaySend?: (text: string) => void
	quayCommand?: (name: string) => void
	quayAbort?: () => void
}

const win = window as unknown as QuayChatWindow

function postStatus(isStreaming: boolean, connectionState: ConnectionState): void {
	win.webkit?.messageHandlers?.status?.postMessage({ isStreaming, connectionState })
}

function ChatApp() {
	const [messages, setMessages] = useState<AgentMessage[]>([])
	const [isStreaming, setIsStreaming] = useState(false)
	const [connection, setConnection] = useState<ConnectionState>('connecting')
	const socketRef = useRef<WebSocket | null>(null)

	// Open the privileged socket and keep it alive (reconnect on drop), loading the
	// existing transcript on connect. The authoritative {type:'agent'} frame replaces
	// our optimistic messages and clears the streaming flag.
	useEffect(() => {
		const token = win.__quayChat?.token ?? ''
		let stopped = false
		let retry: ReturnType<typeof setTimeout> | undefined
		const connect = () => {
			setConnection('connecting')
			const ws = new WebSocket(`ws://${location.host}/?token=${encodeURIComponent(token)}`)
			socketRef.current = ws
			ws.onopen = () => {
				setConnection('ready')
				ws.send(JSON.stringify({ type: 'agent.history' }))
			}
			ws.onmessage = (event) => {
				const msg = JSON.parse(String(event.data)) as { type?: string; messages?: AgentMessage[] }
				if (msg.type === 'agent' && msg.messages) {
					setMessages(msg.messages)
					setIsStreaming(false)
				}
			}
			ws.onerror = () => ws.close()
			ws.onclose = () => {
				socketRef.current = null
				if (stopped) return
				setConnection('disconnected')
				retry = setTimeout(connect, 1000)
			}
		}
		connect()
		return () => {
			stopped = true
			clearTimeout(retry)
			socketRef.current?.close()
		}
	}, [])

	// Wire the native input bridge to the live socket. Enter in the native composer
	// calls quaySend; the Stop button calls quayAbort.
	useEffect(() => {
		win.quaySend = (text) => {
			const trimmed = String(text ?? '').trim()
			const ws = socketRef.current
			if (!trimmed || ws?.readyState !== WebSocket.OPEN) return
			setMessages((prev) => [
				...prev,
				{ id: crypto.randomUUID(), role: 'user', content: trimmed },
				{ id: 'pending', role: 'assistant', content: '' }
			])
			setIsStreaming(true)
			ws.send(JSON.stringify({ type: 'prompt', text: trimmed }))
		}
		// Run a slash command by name (the native composer's `/` menu picked it). Unlike
		// quaySend there's no optimistic user bubble — the authoritative transcript carries
		// the right shape: `/new` returns an empty list (clears the chat), a skill returns
		// its `/name` invocation + the turn. A bare streaming placeholder bridges the wait.
		win.quayCommand = (name) => {
			const ws = socketRef.current
			if (!name || ws?.readyState !== WebSocket.OPEN) return
			setMessages((prev) => [...prev, { id: 'pending', role: 'assistant', content: '' }])
			setIsStreaming(true)
			ws.send(JSON.stringify({ type: 'command', name }))
		}
		win.quayAbort = () => {
			socketRef.current?.send(JSON.stringify({ type: 'abort' }))
			setIsStreaming(false)
		}
		return () => {
			win.quaySend = undefined
			win.quayCommand = undefined
			win.quayAbort = undefined
		}
	}, [])

	useEffect(() => {
		postStatus(isStreaming, connection)
	}, [isStreaming, connection])

	// Picking a question option is just the next prompt — reuse the same input bridge
	// (optimistic user bubble + ws send) that the native composer drives.
	return (
		<Transcript
			messages={messages}
			isStreaming={isStreaming}
			onOption={(label) => win.quaySend?.(label)}
		/>
	)
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<ChatApp />)
