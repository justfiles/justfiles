import type { SessionEntry, SessionStatus } from '@justfiles/agent'
import type { SessionClientMessage, SessionServerMessage } from '@justfiles/agent/protocol'
import type { AgentMessage } from '@justfiles/ui/Transcript'
import { useCallback, useEffect, useRef, useState } from 'react'

// The launcher's agent transport: a plain WebSocket to the daemon's `/agent` socket, which
// is a live view of the shared session. The daemon sends a snapshot, then pushes durable
// items and current status, including work started by `/skill`. Shared by the in-page
// launcher chat (main.tsx) and the native chat surface (chat.tsx). Commands are NOT sent here — they ride
// `/system` and reach the agent (if at all) as a skill, surfacing naturally in the push.

type Connection = 'connecting' | 'ready' | 'disconnected'

export function useAgentChat() {
	const [messages, setMessages] = useState<AgentMessage[]>([])
	const [isStreaming, setIsStreaming] = useState(false)
	const [connection, setConnection] = useState<Connection>('connecting')
	const [error, setError] = useState<string | null>(null)
	const socketRef = useRef<WebSocket | null>(null)
	const historyRef = useRef<readonly SessionEntry[]>([])
	const statusRef = useRef<SessionStatus>({ state: 'idle' })
	const submittingRef = useRef(false)
	const pendingMessageRef = useRef<string | null>(null)

	const setStatus = useCallback((status: SessionStatus) => {
		statusRef.current = status
		setIsStreaming(submittingRef.current || status.state !== 'idle')
	}, [])

	const setSubmitting = useCallback((submitting: boolean) => {
		submittingRef.current = submitting
		setIsStreaming(submitting || statusRef.current.state !== 'idle')
	}, [])

	const replaceHistory = useCallback((history: readonly SessionEntry[]) => {
		historyRef.current = history
		setMessages(sessionEntriesToMessages(history))
	}, [])

	// Subscribe to the live session, reconnecting on drop. A daemon restart sends fresh state.
	useEffect(() => {
		let stopped = false
		let retry: ReturnType<typeof setTimeout> | undefined
		let socket: WebSocket | undefined
		const connect = () => {
			setConnection('connecting')
			const nextSocket = new WebSocket(
				`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/agent`
			)
			socket = nextSocket
			socketRef.current = nextSocket
			nextSocket.onmessage = (ev) => {
				if (socketRef.current !== nextSocket) return
				const message = JSON.parse(String(ev.data)) as SessionServerMessage
				if (message.type === 'snapshot') {
					replaceHistory(message.history)
					setSubmitting(false)
					setStatus(message.status)
					setConnection('ready')
					setError(null)
				} else if (message.type === 'item') {
					replaceHistory([...historyRef.current, message.item])
				} else if (message.type === 'status') {
					setStatus(message.status)
					if (message.status.state === 'idle') replaceHistory(historyRef.current)
					if (message.error) {
						const error = message.error
						setMessages((messages) => [
							...messages,
							{
								id: crypto.randomUUID(),
								role: 'assistant',
								content: error.message,
								error: true
							}
						])
					}
				} else if (message.type === 'accepted' || message.type === 'rejected') {
					setSubmitting(false)
					if (message.type === 'rejected' && pendingMessageRef.current) {
						const id = pendingMessageRef.current
						setMessages((messages) => messages.filter((message) => message.id !== id))
					}
					pendingMessageRef.current = null
				}
			}
			nextSocket.onerror = () => nextSocket.close()
			nextSocket.onclose = () => {
				if (stopped || socketRef.current !== nextSocket) return
				socketRef.current = null
				setSubmitting(false)
				setStatus({ state: 'idle' })
				replaceHistory(historyRef.current)
				setConnection('disconnected')
				retry = setTimeout(connect, 1000)
			}
		}
		connect()
		return () => {
			stopped = true
			clearTimeout(retry)
			socket?.close()
		}
	}, [replaceHistory, setStatus, setSubmitting])

	const send = useCallback(
		(text: string) => {
			const trimmed = text.trim()
			const socket = socketRef.current
			if (
				!trimmed ||
				!socket ||
				socket.readyState !== WebSocket.OPEN ||
				submittingRef.current ||
				statusRef.current.state !== 'idle'
			)
				return
			setSubmitting(true)
			setError(null)
			const id = crypto.randomUUID()
			pendingMessageRef.current = id
			setMessages((messages) => [
				...messages,
				{
					id,
					role: 'user',
					content: trimmed,
					source: 'user'
				}
			])
			socket.send(JSON.stringify({ type: 'prompt', text: trimmed } satisfies SessionClientMessage))
		},
		[setSubmitting]
	)

	const abort = useCallback(() => {
		const socket = socketRef.current
		if (statusRef.current.state === 'idle' || !socket || socket.readyState !== WebSocket.OPEN)
			return
		socket.send(JSON.stringify({ type: 'abort' } satisfies SessionClientMessage))
	}, [])

	return { messages, isStreaming, connection, error, send, abort }
}

function sessionEntriesToMessages(entries: readonly SessionEntry[]): AgentMessage[] {
	const messages: AgentMessage[] = []
	for (const entry of entries) {
		if (entry.type !== 'message') continue
		// An ask_user call renders as a question bubble with clickable options (below),
		// so its paired result carries no user-facing content — drop it.
		if (entry.role === 'tool_result' && entry.tool_name === 'ask_user') continue
		if (entry.role === 'tool_result') {
			const call = findPendingToolCall(messages, entry.tool_name)
			if (call) {
				call.result = parseToolResult(entry.content)
				call.status = 'done'
				continue
			}
		}
		const message = sessionEntryToMessage(entry)
		if (message) messages.push(message)
	}
	return messages
}

function sessionEntryToMessage(
	entry: Extract<SessionEntry, { type: 'message' }>
): AgentMessage | null {
	switch (entry.role) {
		case 'user':
			return { id: entry.id, role: 'user', content: entry.content, source: entry.source }
		case 'assistant':
			return { id: entry.id, role: 'assistant', content: entry.content }
		case 'assistant_thinking':
			return { id: entry.id, role: 'assistant', content: '', thinking: entry.content }
		case 'tool_call':
			// ask_user is a question, not mechanical work: render the agent's question as
			// an assistant bubble whose options are clickable rows (a pick is the next
			// prompt), rather than a collapsed tool row.
			if (entry.tool_name === 'ask_user') {
				const input = entry.input as { question?: string; options?: string[] }
				return {
					id: entry.id,
					role: 'assistant',
					content: input.question ?? '',
					options: (input.options ?? []).map((label) => ({ label }))
				}
			}
			return {
				id: entry.id,
				role: 'assistant',
				content: '',
				toolCalls: [{ id: entry.id, name: entry.tool_name, args: entry.input, status: 'running' }]
			}
		case 'tool_result':
			return {
				id: entry.id,
				role: 'assistant',
				content: '',
				toolCalls: [
					{
						id: entry.id,
						name: entry.tool_name,
						args: {},
						result: parseToolResult(entry.content),
						status: 'done'
					}
				]
			}
	}
}

function findPendingToolCall(messages: AgentMessage[], name: string) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const call = messages[i].toolCalls?.findLast(
			(call) => call.name === name && call.result === undefined
		)
		if (call) return call
	}
	return null
}

function parseToolResult(content: string): unknown {
	try {
		return JSON.parse(content)
	} catch {
		return content
	}
}
