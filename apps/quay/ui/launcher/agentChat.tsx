import type { AgentMessage } from '@justfiles/ui/Transcript'
import { newWebSocketRpcSession } from 'capnweb'
import { useCallback, useEffect, useRef, useState } from 'react'

// The launcher's agent transport: a Cap'n Web RPC session to the daemon's `/agent`
// socket (prompt/history). Shared by the in-page launcher chat (main.tsx) and the
// native chat surface (chat.tsx) so both drive the agent identically. The agent is
// request/response, so a turn shows an optimistic user bubble + a streaming-caret
// placeholder until the authoritative transcript returns.

type Connection = 'connecting' | 'ready' | 'disconnected'

type AgentApi = {
	prompt(message: string): Promise<string>
	history(): Promise<SessionEntry[]>
}

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
	const apiRef = useRef<AgentApi | null>(null)

	useEffect(() => {
		let stopped = false
		const api = newWebSocketRpcSession<AgentApi>(
			`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/agent`
		)
		apiRef.current = api
		void api
			.history()
			.then((history) => {
				if (stopped) return
				setMessages(sessionEntriesToMessages(history))
				setConnection('ready')
				setError(null)
			})
			.catch((err) => {
				if (stopped) return
				setConnection('disconnected')
				setError(errorMessage(err))
			})
		return () => {
			stopped = true
			apiRef.current = null
			api[Symbol.dispose]?.()
		}
	}, [])

	const send = useCallback(async (text: string) => {
		const trimmed = text.trim()
		const api = apiRef.current
		if (!trimmed || !api) return

		const pendingId = `pending-${crypto.randomUUID()}`
		setMessages((prev) => [
			...prev,
			{ id: crypto.randomUUID(), role: 'user', content: trimmed },
			{ id: pendingId, role: 'assistant', content: '' }
		])
		setIsStreaming(true)
		setError(null)

		try {
			const answer = await api.prompt(trimmed)
			try {
				setMessages(sessionEntriesToMessages(await api.history()))
			} catch {
				setMessages((prev) =>
					prev.map((message) =>
						message.id === pendingId ? { ...message, content: answer } : message
					)
				)
			}
			setConnection('ready')
		} catch (err) {
			const message = errorMessage(err)
			setError(message)
			setMessages((prev) => [
				...prev.filter((entry) => entry.id !== pendingId),
				{ id: crypto.randomUUID(), role: 'assistant', content: message, error: true }
			])
		} finally {
			setIsStreaming(false)
		}
	}, [])

	return { messages, isStreaming, connection, error, send }
}

function sessionEntriesToMessages(entries: readonly SessionEntry[]): AgentMessage[] {
	const messages: AgentMessage[] = []
	for (const entry of entries) {
		if (entry.type !== 'message') continue
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
