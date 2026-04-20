import { useEffect, useRef } from 'react'
import { ToolCallBlock } from './ToolCallBlock'
import type { ChatViewProps } from './types'

export function ClassicView(props: ChatViewProps) {
	const { messages, input, setInput, connectionState, isStreaming, sendMessage, abort } = props
	const messagesEndRef = useRef<HTMLDivElement>(null)
	const inputRef = useRef<HTMLTextAreaElement>(null)

	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
	}, [messages])

	const submit = () => {
		sendMessage()
		inputRef.current?.focus()
	}

	return (
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

			<form
				className="flex gap-2 border-t border-base-300 p-4"
				onSubmit={(event) => {
					event.preventDefault()
					submit()
				}}
			>
				<textarea
					ref={inputRef}
					className="textarea textarea-bordered min-h-10 max-h-32 flex-1 resize-none leading-normal"
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
					<button type="button" className="btn btn-error btn-sm self-end" onClick={abort}>
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
		</div>
	)
}
