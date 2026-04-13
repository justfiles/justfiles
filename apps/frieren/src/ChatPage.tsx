import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { navigate } from './clientRouter'

type ConnectionState = 'connecting' | 'ready' | 'disconnected'

interface ChatMessage {
	id: string
	role: 'user' | 'assistant'
	content: string
	thinking?: string
	toolCalls?: ToolCallInfo[]
}

interface ToolCallInfo {
	id: string
	name: string
	args: unknown
	result?: unknown
	isError?: boolean
	status: 'running' | 'done'
}

interface AgentEvent {
	type: string
	message?: {
		role: string
	}
	assistantMessageEvent?: {
		type: string
		delta?: string
	}
	toolCallId?: string
	toolName?: string
	args?: unknown
	result?: unknown
	isError?: boolean
}

const statusBadge: Record<ConnectionState, string> = {
	ready: 'badge-success',
	connecting: 'badge-warning',
	disconnected: 'badge-error'
}

export function ChatPage() {
	const [messages, setMessages] = useState<ChatMessage[]>([])
	const [input, setInput] = useState('')
	const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected')
	const [isStreaming, setIsStreaming] = useState(false)
	const [connectKey, setConnectKey] = useState(0)

	const wsRef = useRef<WebSocket | null>(null)
	const messagesEndRef = useRef<HTMLDivElement>(null)
	const inputRef = useRef<HTMLTextAreaElement>(null)
	const currentAssistantIdRef = useRef<string | null>(null)

	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
	}, [messages])

	useEffect(() => {
		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
		const ws = new WebSocket(`${protocol}//${window.location.host}/ws`)

		setConnectionState('connecting')
		wsRef.current = ws

		ws.onmessage = (event) => {
			const data = JSON.parse(event.data)

			if (data.type === 'ready') {
				setConnectionState('ready')
				return
			}

			if (data.type === 'history') {
				const restored: ChatMessage[] = (data.messages ?? []).map(
					(m: {
						role: string
						content: string
						thinking?: string
						toolCalls?: { name: string; args: unknown; result?: unknown; isError?: boolean }[]
					}) => ({
						id: crypto.randomUUID(),
						role: m.role as 'user' | 'assistant',
						content: m.content,
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
				if (restored.length > 0) {
					setMessages(restored)
				}
				return
			}

			if (data.type === 'error') {
				console.error('Server error:', data.message)
				setIsStreaming(false)
				return
			}

			if (data.type === 'event') {
				handleAgentEvent(data.event)
			}
		}

		ws.onclose = () => {
			if (wsRef.current === ws) {
				setConnectionState('disconnected')
				setIsStreaming(false)
				wsRef.current = null
			}
		}

		ws.onerror = () => {
			if (wsRef.current === ws) {
				setConnectionState('disconnected')
				setIsStreaming(false)
			}
		}

		return () => {
			ws.close()
		}
	}, [connectKey])

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
					setMessages((prev) => [...prev, { id, role: 'assistant', content: '', thinking: '', toolCalls: [] }])
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
				if (!currentId) break
				setMessages((prev) =>
					prev.map((message) =>
						message.id === currentId
							? {
								...message,
								toolCalls: [
									...(message.toolCalls ?? []),
									{
										id: event.toolCallId!,
										name: event.toolName!,
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

	const sendMessage = (event: FormEvent) => {
		event.preventDefault()
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
		inputRef.current?.focus()
	}

	const handleAbort = () => {
		wsRef.current?.send(JSON.stringify({ type: 'abort' }))
	}

	return (
		<div className="flex h-screen flex-col">
			<header className="navbar min-h-12 border-b border-base-300 px-4">
				<div className="flex flex-1 items-center gap-3">
					<span className="text-lg font-semibold">Frieren</span>
					<button
						type="button"
						className="btn btn-ghost btn-xs text-base-content/60"
						onClick={() => navigate('/files')}
					>
						Files
					</button>
				</div>
				<div className="flex-none">
					<span className={`badge badge-sm ${statusBadge[connectionState]}`}>
						{connectionState}
					</span>
				</div>
			</header>

			<div className="mx-auto flex w-full max-w-3xl flex-1 flex-col overflow-hidden">
				<div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
					{messages.length === 0 ? (
						<div className="flex flex-1 items-center justify-center text-base-content/40">
							<p>Send a message to start chatting.</p>
						</div>
					) : null}

					{messages.map((message) => (
						<div
							key={message.id}
							className={`chat ${message.role === 'user' ? 'chat-end' : 'chat-start'}`}
						>
							<div className="chat-header mb-1 text-xs opacity-60">
								{message.role === 'user' ? 'You' : 'Frieren'}
							</div>
							<div
								className={`chat-bubble whitespace-pre-wrap break-words ${
									message.role === 'user' ? 'chat-bubble-primary' : 'chat-bubble-neutral'
								}`}
							>
								{message.content}
								{!message.content && isStreaming && message.role === 'assistant' ? (
									<span className="ml-px inline-block h-[1em] w-0.5 animate-pulse bg-current align-text-bottom" />
								) : null}
							</div>
							{message.role === 'assistant' && message.thinking ? (
								<details className="mt-2 rounded-lg border border-base-300 bg-base-200/50">
									<summary className="cursor-pointer px-3 py-2 text-xs font-semibold uppercase tracking-wide opacity-60">
										Thinking
									</summary>
									<pre className="overflow-x-auto whitespace-pre-wrap break-words px-3 pb-3 text-xs">
										{message.thinking}
									</pre>
								</details>
							) : null}
							{message.toolCalls && message.toolCalls.length > 0 ? (
								<div className="chat-footer mt-2 flex w-full flex-col gap-1.5">
									{message.toolCalls.map((toolCall) => (
										<ToolCallBlock key={toolCall.id} toolCall={toolCall} />
									))}
								</div>
							) : null}
						</div>
					))}

					<div ref={messagesEndRef} />
				</div>

				<form className="flex gap-2 border-t border-base-300 p-4" onSubmit={sendMessage}>
					<textarea
						ref={inputRef}
						className="textarea textarea-bordered min-h-10 max-h-32 flex-1 resize-none leading-normal"
						value={input}
						onChange={(event) => setInput(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === 'Enter' && !event.shiftKey) {
								event.preventDefault()
								sendMessage(event)
							}
						}}
						placeholder={
							connectionState === 'ready'
								? 'Send a message... (Enter to send, Shift+Enter for newline)'
								: 'Connecting...'
						}
						disabled={connectionState !== 'ready'}
						rows={1}
					/>
					{isStreaming ? (
						<button
							type="button"
							className="btn btn-error btn-sm self-end"
							onClick={handleAbort}
						>
							Stop
						</button>
					) : (
						<button
							type="submit"
							className="btn btn-primary btn-sm self-end"
							disabled={!input.trim() || connectionState !== 'ready'}
						>
							Send
						</button>
					)}
				</form>

				{connectionState === 'disconnected' ? (
					<div className="px-4 pb-4">
						<button
							type="button"
							className="btn btn-outline btn-block btn-sm"
							onClick={() => setConnectKey((value) => value + 1)}
						>
							Reconnect
						</button>
					</div>
				) : null}
			</div>
		</div>
	)
}

function ToolCallBlock({ toolCall }: { toolCall: ToolCallInfo }) {
	const [expanded, setExpanded] = useState(false)

	const indicatorClass =
		toolCall.status === 'running'
			? 'text-warning'
			: toolCall.isError
				? 'text-error'
				: 'text-success'

	const indicatorLabel =
		toolCall.status === 'running' ? '...' : toolCall.isError ? 'x' : 'ok'

	return (
		<div
			className={`collapse collapse-arrow rounded-lg border border-base-300 bg-base-200/50 ${
				toolCall.isError ? 'border-error/30' : ''
			}`}
		>
			<input
				type="checkbox"
				checked={expanded}
				onChange={() => setExpanded(!expanded)}
			/>
			<div className="collapse-title min-h-0 py-2 px-3 text-sm after:!top-4">
				<div className="flex items-center gap-2">
					<span className={`badge badge-xs font-mono text-xs ${indicatorClass}`}>
						{indicatorLabel}
					</span>
					<span className="flex-1 font-mono">{toolCall.name}</span>
				</div>
			</div>
			<div className="collapse-content px-3 pb-3 text-sm">
				<div className="mb-2">
					<div className="mb-1 text-xs font-semibold uppercase tracking-wide opacity-50">
						Arguments
					</div>
					<pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-base-300 p-2 text-xs">
						{JSON.stringify(toolCall.args, null, 2)}
					</pre>
				</div>
				{toolCall.result !== undefined ? (
					<div>
						<div className="mb-1 text-xs font-semibold uppercase tracking-wide opacity-50">
							Result
						</div>
						<pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-base-300 p-2 text-xs">
							{JSON.stringify(toolCall.result, null, 2)}
						</pre>
					</div>
				) : null}
			</div>
		</div>
	)
}
