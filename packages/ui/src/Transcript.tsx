import { type CSSProperties, useLayoutEffect, useRef } from 'react'

export interface ToolCallInfo {
	id: string
	name: string
	args: unknown
	result?: unknown
	isError?: boolean
	status: 'running' | 'done'
}

export interface AgentMessage {
	id: string
	role: 'user' | 'assistant'
	content: string
	source?: 'user' | 'app'
	thinking?: string
	toolCalls?: ToolCallInfo[]
}

export interface TranscriptProps {
	messages: AgentMessage[]
	isStreaming: boolean
}

// Scoped CSS for the bits inline styles can't express: the streaming caret
// keyframes and the disclosure-row marker reset. Kept local to the component
// (see NATIVE-LAUNCHER-PLAN §Styling) rather than promoted to the shared sheet.
const css = `
.js-transcript summary { list-style: none; cursor: pointer; }
.js-transcript summary::-webkit-details-marker { display: none; }
@keyframes js-transcript-caret { 0%, 100% { opacity: 1 } 50% { opacity: 0 } }
`

// Presentation-only agent transcript: a scrolling message history with bubbles,
// collapsible thinking / tool-call rows, and a streaming caret. Transport-
// agnostic — the host owns the session, header, and composer. Styled on
// @justfiles/design tokens (no Tailwind) so it renders in any token-aware shell.
export function Transcript({ messages, isStreaming }: TranscriptProps) {
	const historyRef = useRef<HTMLDivElement>(null)

	useLayoutEffect(() => {
		void messages.length
		const el = historyRef.current
		if (el) el.scrollTop = el.scrollHeight
	}, [messages.length])

	return (
		<div
			ref={historyRef}
			className="js-transcript"
			style={{
				display: 'flex',
				flexDirection: 'column',
				gap: '8px',
				flex: 1,
				minHeight: 0,
				overflowY: 'auto',
				padding: '12px'
			}}
		>
			<style>{css}</style>
			{messages.map((m) => (
				<MessageItem key={m.id} message={m} isStreaming={isStreaming} />
			))}
		</div>
	)
}

function MessageItem({ message, isStreaming }: { message: AgentMessage; isStreaming: boolean }) {
	if (message.source === 'app') {
		return <SystemRow label="From app" body={message.content} />
	}

	if (message.role === 'user') {
		return <Bubble side="right" content={message.content} streaming={false} />
	}

	const showCursor = isStreaming && !message.content && !message.toolCalls?.length
	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
			{message.content || showCursor ? (
				<Bubble side="left" content={message.content} streaming={showCursor} />
			) : null}
			{message.thinking ? (
				<SystemRow label="Thinking" body={message.thinking} mono={false} />
			) : null}
			{message.toolCalls?.map((tc) => (
				<ToolCallRow key={tc.id} call={tc} />
			))}
		</div>
	)
}

function Bubble(props: { side: 'left' | 'right'; content: string; streaming: boolean }) {
	const { side, content, streaming } = props
	const isUser = side === 'right'
	return (
		<div style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
			<div
				style={{
					maxWidth: '78%',
					whiteSpace: 'pre-wrap',
					overflowWrap: 'break-word',
					padding: '6px 12px',
					borderRadius: '14px',
					background: isUser ? 'var(--focus)' : 'var(--surface-subtle)',
					color: isUser ? 'var(--on-focus)' : 'var(--text)'
				}}
			>
				{content}
				{streaming ? (
					<span
						style={{
							display: 'inline-block',
							width: '2px',
							height: '1em',
							marginLeft: '1px',
							verticalAlign: 'text-bottom',
							background: 'currentColor',
							animation: 'js-transcript-caret 1s step-end infinite'
						}}
					/>
				) : null}
			</div>
		</div>
	)
}

function SystemRow(props: { label: string; body: string; mono?: boolean }) {
	return (
		<details style={{ alignSelf: 'center', fontSize: '11px', opacity: 0.6 }}>
			<summary style={{ padding: '2px 8px' }}>
				<span style={{ textTransform: 'uppercase', letterSpacing: '0.04em' }}>{props.label}</span>
			</summary>
			<pre
				style={{
					margin: '4px 0 0',
					maxHeight: '12rem',
					maxWidth: '80ch',
					overflow: 'auto',
					whiteSpace: 'pre-wrap',
					overflowWrap: 'break-word',
					borderRadius: '4px',
					padding: '4px 8px',
					background: 'var(--surface)',
					border: '1px solid var(--rule)',
					fontFamily: props.mono === false ? 'inherit' : 'var(--font-mono)'
				}}
			>
				{props.body}
			</pre>
		</details>
	)
}

function ToolCallRow(props: { call: ToolCallInfo }) {
	const { call } = props
	// Status hues read on both themes (like the traffic-light controls) so they
	// stay literal; "done" uses currentColor so it follows the text token.
	const dot = call.status === 'running' ? '#f59e0b' : call.isError ? '#dc2626' : 'currentColor'
	const args = call.args === undefined ? null : JSON.stringify(call.args, null, 2)
	const result = call.result === undefined ? null : JSON.stringify(call.result, null, 2)
	const preStyle: CSSProperties = {
		margin: 0,
		maxHeight: '8rem',
		overflow: 'auto',
		whiteSpace: 'pre-wrap',
		overflowWrap: 'break-word',
		borderRadius: '4px',
		padding: '4px 8px',
		fontFamily: 'var(--font-mono)',
		background: 'var(--surface)',
		border: '1px solid var(--rule)'
	}
	return (
		<details style={{ alignSelf: 'center', fontSize: '11px', opacity: 0.7 }}>
			<summary style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '2px 8px' }}>
				<span
					role="img"
					aria-label={call.status === 'running' ? 'running' : call.isError ? 'error' : 'done'}
					style={{
						display: 'inline-block',
						width: '6px',
						height: '6px',
						borderRadius: '999px',
						background: dot
					}}
				/>
				<span style={{ fontFamily: 'var(--font-mono)' }}>{call.name}</span>
			</summary>
			<div
				style={{
					marginTop: '4px',
					display: 'flex',
					flexDirection: 'column',
					gap: '4px',
					maxWidth: '80ch'
				}}
			>
				{args !== null ? <pre style={preStyle}>{args}</pre> : null}
				{result !== null ? (
					<pre
						style={{
							...preStyle,
							background: call.isError
								? 'color-mix(in srgb, #dc2626 14%, var(--surface))'
								: 'var(--surface)'
						}}
					>
						{result}
					</pre>
				) : null}
			</div>
		</details>
	)
}
