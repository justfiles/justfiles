import { Transcript } from '@justfiles/ui/Transcript'
import { useRef } from 'react'
import { useAutoResize } from '../components/useAutoResize'
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
					<img
						src={avatarUrl}
						alt=""
						width={48}
						height={48}
						className="frn-agent-avatar"
						data-personalized={personalized}
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
					alignItems: 'flex-end',
					gap: 8,
					padding: '8px 12px',
					borderTop: '1px solid var(--rule)'
				}}
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
					// Colors come from the design tokens (mac.css styles bare textareas);
					// only the pill shape and layout are local. Height comes from
					// rows=1 line-height + padding, so a single line sits centered.
					style={{
						flex: 1,
						maxHeight: 128,
						resize: 'none',
						borderRadius: 999,
						padding: '4px 12px',
						lineHeight: '20px'
					}}
				/>
				{isStreaming ? (
					<button
						type="button"
						onClick={abort}
						style={{ borderRadius: 5, padding: '4px 12px', color: '#fff', background: '#d33' }}
					>
						Stop
					</button>
				) : (
					<button
						type="submit"
						disabled={!input.trim() || !ready}
						style={{
							borderRadius: 5,
							padding: '4px 12px',
							background: 'var(--focus)',
							color: 'var(--on-focus)'
						}}
					>
						Send
					</button>
				)}
			</form>
		</div>
	)
}
