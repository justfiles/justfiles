import type { AgentMessage } from '@justfiles/ui/Transcript'
import { useCallback, useEffect, useRef, useState } from 'react'

// The launcher's agent transport: a plain WebSocket to the daemon's `/agent` socket, which
// is a LIVE VIEW of the shared session. The daemon pushes the whole transcript on every
// change (its own turns, or a `/skill` dispatched over `/system`), plus a busy flag and
// turn errors; the client only sends prompts. Shared by the in-page launcher chat
// (main.tsx) and the native chat surface (chat.tsx). Commands are NOT sent here — they ride
// `/system` and reach the agent (if at all) as a skill, surfacing naturally in the push.

type Connection = 'connecting' | 'ready' | 'disconnected'

// Server→client on `/agent` (mirrors the daemon's AgentEvent).
type AgentEvent =
	| { type: 'history'; entries: SessionEntry[] }
	| { type: 'busy'; value: boolean }
	| { type: 'error'; message: string }

type SessionEntry =
	| { id: string; type: 'message'; role: 'user'; content: string; source?: 'user' | 'app' }
	| { id: string; type: 'message'; role: 'assistant' | 'assistant_thinking'; content: string }
	| { id: string; type: 'message'; role: 'tool_call'; tool_name: string; input: unknown }
	| { id: string; type: 'message'; role: 'tool_result'; tool_name: string; content: string }
	| { id: string; type: 'compaction'; summary: string }
	| { id: string; type: 'branch_summary' | 'label' }

export function useAgentChat() {
	const [messages, setMessages] = useState<AgentMessage[]>([])
	const [isStreaming, setIsStreaming] = useState(false)
	const [connection, setConnection] = useState<Connection>('connecting')
	const [error, setError] = useState<string | null>(null)
	const socketRef = useRef<WebSocket | null>(null)

	// Subscribe to the live session, reconnecting on drop (a daemon restart re-pushes the
	// snapshot on the new socket). Every `history` frame is the authoritative transcript, so
	// it replaces local state — including any optimistic bubble `send` added.
	useEffect(() => {
		let stopped = false
		let retry: ReturnType<typeof setTimeout> | undefined
		let socket: WebSocket | undefined
		const connect = () => {
			setConnection('connecting')
			socket = new WebSocket(
				`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/agent`
			)
			socketRef.current = socket
			socket.onmessage = (ev) => {
				const event = JSON.parse(String(ev.data)) as AgentEvent
				if (event.type === 'history') {
					setMessages(sessionEntriesToMessages(event.entries))
					setConnection('ready')
					setError(null)
				} else if (event.type === 'busy') {
					setIsStreaming(event.value)
				} else if (event.type === 'error') {
					setError(event.message)
				}
			}
			socket.onerror = () => socket?.close()
			socket.onclose = () => {
				if (stopped) return
				socketRef.current = null
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
	}, [])

	// Send a chat message. Optimistic user bubble + empty assistant placeholder (which shows
	// the streaming caret) until the turn's `history` push replaces the whole transcript.
	const send = useCallback((text: string) => {
		const trimmed = text.trim()
		const socket = socketRef.current
		if (!trimmed || !socket || socket.readyState !== WebSocket.OPEN) return
		setMessages((prev) => [
			...prev,
			{ id: crypto.randomUUID(), role: 'user', content: trimmed },
			{ id: crypto.randomUUID(), role: 'assistant', content: '' }
		])
		setIsStreaming(true)
		setError(null)
		socket.send(JSON.stringify({ type: 'prompt', text: trimmed }))
	}, [])

	return { messages, isStreaming, connection, error, send }
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
