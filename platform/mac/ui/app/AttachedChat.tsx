import { Transcript } from '@justfiles/ui/Transcript'
import { useEffect, useState } from 'react'
import { useAgentChat } from '../launcher/agentChat'

export function AttachedChat({
	appId,
	onStreamingChange
}: {
	appId: string
	onStreamingChange: (streaming: boolean) => void
}) {
	const chat = useAgentChat(appId)
	const [draft, setDraft] = useState('')
	const ready = chat.connection === 'ready'

	useEffect(() => onStreamingChange(chat.isStreaming), [chat.isStreaming, onStreamingChange])
	useEffect(() => () => onStreamingChange(false), [onStreamingChange])

	const send = () => {
		const text = draft.trim()
		if (!text || !ready || chat.isStreaming) return
		chat.send(text)
		setDraft('')
	}
	const messages = chat.error
		? [
				...chat.messages,
				{
					id: 'agent-error',
					role: 'assistant' as const,
					content: chat.error,
					error: true as const
				}
			]
		: chat.messages

	return (
		<div className="mac-attached-chat">
			<div className="mac-attached-chat-history">
				{messages.length ? (
					<Transcript
						messages={messages}
						isStreaming={chat.isStreaming}
						activity={{ loadDetail: chat.loadActivityDetail }}
						onOption={(label) => chat.send(label)}
					/>
				) : (
					<p>{ready ? 'Ask about this app.' : 'Connecting to agent…'}</p>
				)}
			</div>
			<form
				className="mac-attached-chat-composer"
				onSubmit={(event) => {
					event.preventDefault()
					send()
				}}
			>
				<textarea
					aria-label="Ask about this app"
					placeholder="Ask about this app"
					rows={2}
					value={draft}
					onChange={(event) => setDraft(event.currentTarget.value)}
					onKeyDown={(event) => {
						if (event.key !== 'Enter' || event.shiftKey) return
						event.preventDefault()
						send()
					}}
				/>
				<button
					type={chat.isStreaming ? 'button' : 'submit'}
					aria-label={chat.isStreaming ? 'Stop' : 'Send'}
					disabled={!ready || (!chat.isStreaming && !draft.trim())}
					onClick={chat.isStreaming ? chat.abort : undefined}
				>
					{chat.isStreaming ? '■' : '↑'}
				</button>
			</form>
		</div>
	)
}
