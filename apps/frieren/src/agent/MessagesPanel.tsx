import { Transcript } from '@justfiles/ui/Transcript'
import { ArrowUpIcon, StopIcon } from '@phosphor-icons/react'
import { useRef } from 'react'
import { useAutoResize } from '../components/useAutoResize'
import { AgentAvatar } from './AgentAvatar'
import { useAgentConnection, useAgentSession } from './hooks'
import { resolveTranscriptImage } from './images'
import { Whisper } from './Whisper'

// OS-level agent surface — invoked from the menubar, not the app launcher.
// The agent is part of the OS, not an app, so this component consumes the
// agent session directly. Wrap it in a window (or whatever shell the host
// decides) at the caller; the panel itself is presentation-only. The scrolling
// transcript is the shared @justfiles/ui component; the header and composer
// below are frieren's own web chrome.
export function MessagesPanel({ onPersonalize }: { onPersonalize: () => void }) {
	const session = useAgentSession()
	const connection = useAgentConnection()
	const {
		messages,
		input,
		setInput,
		agentName,
		avatarUrl,
		avatarFaces,
		expression,
		personalized,
		isStreaming,
		sendMessage,
		abort
	} = session
	const ready = connection.state === 'ready'
	const inputRef = useRef<HTMLTextAreaElement>(null)
	// Grow the composer with wrapped lines, then scroll past ~6 (128px).
	useAutoResize(inputRef, input, 128)

	const submit = () => {
		sendMessage()
		inputRef.current?.focus()
	}

	return (
		<div
			style={{
				display: 'flex',
				flexDirection: 'column',
				height: '100%',
				width: '100%',
				background: 'transparent',
				color: 'var(--text)',
				fontFamily: 'var(--font-ui)',
				fontSize: 'var(--text-ui)'
			}}
		>
			<header
				style={{
					display: 'flex',
					flex: 'none',
					flexDirection: 'column',
					alignItems: 'center',
					gap: 4,
					padding: '12px',
					borderBottom: '1px solid var(--rule)'
				}}
			>
				<button
					type="button"
					className="frn-agent-identity"
					onClick={onPersonalize}
					title="Personalize"
				>
					<AgentAvatar
						url={avatarUrl}
						faces={avatarFaces}
						expression={expression}
						streaming={isStreaming}
						personalized={personalized}
						size={48}
					/>
					<span style={{ fontWeight: 500 }}>{agentName}</span>
				</button>
				<span className="frn-agent-status">
					{ready ? (
						<>
							Online
							{personalized ? null : <em> · default persona</em>}
						</>
					) : connection.state === 'connecting' ? (
						'Connecting…'
					) : (
						'Offline'
					)}
				</span>
			</header>

			{messages.length === 0 ? (
				<div style={{ margin: 'auto', fontSize: 12, opacity: 0.5 }}>
					Say something to {agentName}.
				</div>
			) : (
				<Transcript
					messages={messages}
					isStreaming={isStreaming}
					resolveImage={resolveTranscriptImage}
				/>
			)}

			{personalized ? null : <Whisper onPersonalize={onPersonalize} />}

			<form
				style={{
					display: 'flex',
					flex: 'none',
					padding: '8px 12px',
					borderTop: '1px solid var(--rule)'
				}}
				onSubmit={(event) => {
					event.preventDefault()
					submit()
				}}
			>
				<div className="frn-chat-field">
					<textarea
						ref={inputRef}
						className="frn-chat-input"
						rows={1}
						value={input}
						onChange={(event) => setInput(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
								event.preventDefault()
								submit()
							}
						}}
						placeholder={ready ? 'iMessage' : 'Connecting…'}
						disabled={!ready}
					/>
					{isStreaming ? (
						<button
							type="button"
							className="frn-chat-send"
							data-variant="stop"
							onClick={abort}
							aria-label="Stop"
							title="Stop"
						>
							<StopIcon weight="fill" />
						</button>
					) : (
						<button
							type="submit"
							className="frn-chat-send"
							disabled={!input.trim() || !ready}
							aria-label="Send"
							title="Send"
						>
							<ArrowUpIcon weight="bold" />
						</button>
					)}
				</div>
			</form>
		</div>
	)
}
