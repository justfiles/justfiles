import { useLayoutEffect, useRef } from 'react'
import { AppPromptBlock } from './AppPromptBlock'
import { ToolCallBlock } from './ToolCallBlock'
import type { ChatViewProps } from './types'

export function ClassicView(props: ChatViewProps) {
	const { session, connection } = props
	const { messages, input, setInput, userName, agentName, isStreaming, sendMessage, abort } =
		session
	const connectionState = connection.state
	const messagesEndRef = useRef<HTMLDivElement>(null)
	const inputRef = useRef<HTMLTextAreaElement>(null)

	useLayoutEffect(() => {
		void messages.length
		messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
	}, [messages.length])

	const submit = () => {
		sendMessage()
		inputRef.current?.focus()
	}

	return (
		<div className="mx-auto flex w-full max-w-3xl flex-1 flex-col overflow-hidden">
			<div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
				{messages.length === 0 ? (
					<div className="flex flex-1 items-center justify-center text-muted-foreground">
						<p>Send a message to start chatting.</p>
					</div>
				) : null}

				{messages.map((message) =>
					message.source === 'app' ? (
						<AppPromptBlock key={message.id} content={message.content} />
					) : (
						<ChatMessageBlock
							key={message.id}
							message={message}
							userName={userName}
							agentName={agentName}
							isStreaming={isStreaming}
						/>
					)
				)}

				<div ref={messagesEndRef} />
			</div>

			<form
				className="flex gap-2 border-t border-border p-4"
				onSubmit={(event) => {
					event.preventDefault()
					submit()
				}}
			>
				<textarea
					ref={inputRef}
					className="min-h-10 max-h-32 flex-1 resize-none rounded border border-input bg-background px-3 py-2 text-sm leading-normal outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50"
					value={input}
					onChange={(event) => setInput(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === 'Enter' && !event.shiftKey) {
							event.preventDefault()
							submit()
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
						className="self-end rounded bg-destructive px-3 py-2 text-sm text-white"
						onClick={abort}
					>
						Stop
					</button>
				) : (
					<button
						type="submit"
						className="self-end rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
						disabled={!input.trim() || connectionState !== 'ready'}
					>
						Send
					</button>
				)}
			</form>
		</div>
	)
}

function ChatMessageBlock(props: {
	message: ChatViewProps['session']['messages'][number]
	userName: string
	agentName: string
	isStreaming: boolean
}) {
	const { message, userName, agentName, isStreaming } = props
	const toolOnly =
		message.role === 'assistant' &&
		!message.content &&
		!message.thinking &&
		!!message.toolCalls?.length

	if (toolOnly) {
		return (
			<div className="flex flex-col items-start">
				<div className="mb-1 text-xs opacity-60">{agentName}</div>
				<ToolCalls message={message} className="w-full max-w-[85%]" />
			</div>
		)
	}

	return (
		<div className={`flex flex-col ${message.role === 'user' ? 'items-end' : 'items-start'}`}>
			<div className="mb-1 text-xs opacity-60">
				{message.role === 'user' ? userName : agentName}
			</div>
			<div
				className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words ${
					message.role === 'user'
						? 'bg-primary text-primary-foreground'
						: 'bg-muted text-foreground'
				}`}
			>
				{message.content}
				{!message.content && isStreaming && message.role === 'assistant' ? (
					<span className="ml-px inline-block h-[1em] w-0.5 animate-pulse bg-current align-text-bottom" />
				) : null}
			</div>
			{message.role === 'assistant' && message.thinking ? (
				<details className="mt-2 rounded-lg border border-border bg-muted/50">
					<summary className="cursor-pointer px-3 py-2 text-xs font-semibold uppercase tracking-wide opacity-60">
						Thinking
					</summary>
					<pre className="overflow-x-auto whitespace-pre-wrap break-words px-3 pb-3 text-xs">
						{message.thinking}
					</pre>
				</details>
			) : null}
			<ToolCalls message={message} className="mt-2 w-full max-w-[85%]" />
		</div>
	)
}

function ToolCalls(props: {
	message: ChatViewProps['session']['messages'][number]
	className: string
}) {
	const { message, className } = props
	if (!message.toolCalls?.length) return null
	return (
		<div className={`flex flex-col gap-1.5 ${className}`}>
			{message.toolCalls.map((toolCall) => (
				<ToolCallBlock key={toolCall.id} toolCall={toolCall} />
			))}
		</div>
	)
}
