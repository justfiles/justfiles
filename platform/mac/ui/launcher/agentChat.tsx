import type { ActiveTurn, SessionEntry } from '@justfiles/agent'
import {
	type AgentFrame,
	type AgentRequest,
	applyAgentFrame,
	type RemoteAgentState
} from '@justfiles/agent/protocol'
import type { AgentMessage } from '@justfiles/ui/Transcript'
import { useCallback, useEffect, useRef, useState } from 'react'

// The launcher's agent transport: a plain WebSocket to the daemon's `/agent` socket, which
// is a LIVE VIEW of the shared session. The daemon pushes the whole transcript on every
// change, including turns started by `/skill`. Shared by the in-page launcher chat
// (main.tsx) and the native chat surface (chat.tsx). Commands are NOT sent here — they ride
// `/system` and reach the agent (if at all) as a skill, surfacing naturally in the push.

type Connection = 'connecting' | 'ready' | 'disconnected'

export function useAgentChat() {
	const [messages, setMessages] = useState<AgentMessage[]>([])
	const [isStreaming, setIsStreaming] = useState(false)
	const [connection, setConnection] = useState<Connection>('connecting')
	const [error, setError] = useState<string | null>(null)
	const socketRef = useRef<WebSocket | null>(null)
	const remoteRef = useRef<RemoteAgentState>({ phase: 'idle', activeTurn: null })

	const setRemote = useCallback((remote: RemoteAgentState) => {
		remoteRef.current = remote
		setIsStreaming(remote.phase !== 'idle')
	}, [])

	const showTurn = useCallback((turn: ActiveTurn) => {
		setMessages((messages) =>
			messages.some((message) => message.id === turn.id)
				? messages
				: [
						...messages,
						{
							id: turn.id,
							role: 'user',
							content: turn.input.text,
							source: turn.input.source
						}
					]
		)
	}, [])

	// Subscribe to the live session, reconnecting on drop (a daemon restart re-pushes the
	// snapshot on the new socket). Every snapshot or finish replaces the local transcript.
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
				const event = JSON.parse(String(ev.data)) as AgentFrame
				if (event.type === 'snapshot') {
					setMessages(sessionEntriesToMessages(event.transcript))
					setRemote(applyAgentFrame(remoteRef.current, event))
					if (event.activeTurn) showTurn(event.activeTurn)
					setConnection('ready')
					setError(null)
				} else if (event.type === 'turn_started') {
					setRemote(applyAgentFrame(remoteRef.current, event))
					showTurn(event.turn)
				} else if (event.type === 'prompt_result') {
					const remote = applyAgentFrame(remoteRef.current, event)
					setRemote(remote)
					const turn = remote.activeTurn
					if (turn) showTurn(turn)
				} else if (event.type === 'turn_finished') {
					const remote = applyAgentFrame(remoteRef.current, event)
					if (remote === remoteRef.current) return
					const next = sessionEntriesToMessages(event.transcript)
					if (event.error)
						next.push({
							id: crypto.randomUUID(),
							role: 'assistant',
							content: event.error.message,
							error: true
						})
					setMessages(next)
					setRemote(remote)
				}
			}
			socket.onerror = () => socket?.close()
			socket.onclose = () => {
				if (stopped) return
				socketRef.current = null
				setRemote({ phase: 'idle', activeTurn: null })
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
	}, [setRemote, showTurn])

	const send = useCallback(
		(text: string) => {
			const trimmed = text.trim()
			const socket = socketRef.current
			if (
				!trimmed ||
				!socket ||
				socket.readyState !== WebSocket.OPEN ||
				remoteRef.current.phase !== 'idle'
			)
				return
			setRemote({ phase: 'submitting', activeTurn: null })
			setError(null)
			socket.send(JSON.stringify({ type: 'prompt', text: trimmed } satisfies AgentRequest))
		},
		[setRemote]
	)

	// Stop names the turn it observed, so a late click cannot cancel newer work.
	const abort = useCallback(() => {
		const socket = socketRef.current
		const turnId = remoteRef.current.activeTurn?.id
		if (!turnId || !socket || socket.readyState !== WebSocket.OPEN) return
		socket.send(JSON.stringify({ type: 'abort', turnId } satisfies AgentRequest))
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
