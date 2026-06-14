import { Transcript } from '@justfiles/ui/Transcript'
import { useRef } from 'react'
import agentAvatarUrl from './agent-avatar.png'
import { useAgentConnection, useAgentSession } from './hooks'

// OS-level agent surface — invoked from the menubar, not the app launcher.
// The agent is part of the OS, not an app, so this component consumes the
// agent session directly. Wrap it in a window (or whatever shell the host
// decides) at the caller; the panel itself is presentation-only. The scrolling
// transcript is the shared @justfiles/ui component; the header and composer
// below are frieren's own web chrome.
export function MessagesPanel() {
	const session = useAgentSession()
	const connection = useAgentConnection()
	const { messages, input, setInput, agentName, isStreaming, sendMessage, abort } = session
	const ready = connection.state === 'ready'
	const inputRef = useRef<HTMLTextAreaElement>(null)

	const submit = () => {
		sendMessage()
		inputRef.current?.focus()
	}

	return (
		<div
			className="flex h-full w-full flex-col"
			style={{
				background: 'transparent',
				color: 'var(--text)',
				fontFamily: 'var(--font-ui)',
				fontSize: 'var(--text-ui)'
			}}
		>
			<header
				className="flex flex-none flex-col items-center gap-1 px-3 py-3"
				style={{ borderBottom: '1px solid rgba(0,0,0,0.07)' }}
			>
				<img
					src={agentAvatarUrl}
					alt=""
					width={48}
					height={48}
					className="rounded-full"
					style={{ imageRendering: 'pixelated' }}
				/>
				<span className="font-medium">{agentName}</span>
				<span className="text-[11px] opacity-50">
					{ready ? 'Online' : connection.state === 'connecting' ? 'Connecting…' : 'Offline'}
				</span>
			</header>

			{messages.length === 0 ? (
				<div className="m-auto text-xs opacity-50">Say something to {agentName}.</div>
			) : (
				<Transcript messages={messages} isStreaming={isStreaming} />
			)}

			<form
				className="flex flex-none items-end gap-2 px-3 py-2"
				style={{ borderTop: '1px solid rgba(0,0,0,0.07)' }}
				onSubmit={(event) => {
					event.preventDefault()
					submit()
				}}
			>
				<textarea
					ref={inputRef}
					rows={1}
					value={input}
					onChange={(event) => setInput(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === 'Enter' && !event.shiftKey) {
							event.preventDefault()
							submit()
						}
					}}
					placeholder={ready ? 'iMessage' : 'Connecting…'}
					disabled={!ready}
					className="min-h-7 max-h-32 flex-1 resize-none rounded-full px-3 py-1 outline-none disabled:opacity-50"
					style={{
						background: 'rgba(255,255,255,0.6)',
						border: '1px solid rgba(255,255,255,0.7)',
						color: 'var(--text)',
						fontFamily: 'var(--font-ui)',
						fontSize: 'var(--text-ui)'
					}}
				/>
				{isStreaming ? (
					<button
						type="button"
						onClick={abort}
						className="rounded px-3 py-1 text-white"
						style={{ background: '#d33' }}
					>
						Stop
					</button>
				) : (
					<button
						type="submit"
						disabled={!input.trim() || !ready}
						className="rounded px-3 py-1 disabled:opacity-40"
						style={{ background: 'var(--focus)', color: 'var(--on-focus)' }}
					>
						Send
					</button>
				)}
			</form>
		</div>
	)
}
