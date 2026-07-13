import { type CSSProperties, type ReactNode, useLayoutEffect, useRef, useState } from 'react'

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
	// A failed agent turn: rendered as an error-styled block, not a normal bubble.
	error?: true
	// A multiple-choice question: rendered as clickable rows under the bubble. A pick
	// calls `onOption` (the host sends it as the next prompt).
	options?: { label: string }[]
}

export interface TranscriptProps {
	messages: AgentMessage[]
	isStreaming: boolean
	// Invoked when the user clicks an option row. Omitted hosts render the labels
	// as plain (non-clickable) rows.
	onOption?: (label: string) => void
	// Rendered above the oldest message, inside the scroll. Off-screen at rest
	// (the view sticks to the bottom) and revealed only when scrolling up for
	// history — the natural spot for a "showing the tail; see the rest" affordance.
	leading?: ReactNode
}

// Scoped CSS for the bits inline styles can't express: the streaming caret
// keyframes and the disclosure-row marker reset. Kept local to the component
// (see NATIVE-LAUNCHER-PLAN §Styling) rather than promoted to the shared sheet.
const css = `
.js-transcript summary { list-style: none; cursor: pointer; }
.js-transcript summary::-webkit-details-marker { display: none; }
@keyframes js-transcript-caret { 0%, 100% { opacity: 1 } 50% { opacity: 0 } }
.js-transcript-option { transition: background 120ms ease, border-color 120ms ease; }
.js-transcript-option:hover { background: var(--control-bg-hover); border-color: var(--focus); }
.js-transcript-option:active { background: var(--control-bg-active); }
.js-transcript-option:focus-visible {
	outline: none;
	border-color: var(--focus);
	box-shadow: 0 0 0 3px color-mix(in srgb, var(--focus) 25%, transparent);
}
.js-transcript-copy { opacity: 0; transition: opacity 120ms ease, background 120ms ease; }
.js-transcript-bubble:hover .js-transcript-copy { opacity: 1; }
.js-transcript-copy:hover { background: color-mix(in srgb, currentColor 14%, transparent); }
.js-transcript-copy:focus-visible {
	opacity: 1;
	outline: none;
	box-shadow: 0 0 0 2px color-mix(in srgb, currentColor 30%, transparent);
}
`

// Presentation-only agent transcript: a scrolling message history with bubbles,
// collapsible thinking / tool-call rows, and a streaming caret. Transport-
// agnostic — the host owns the session, header, and composer. Styled on
// @justfiles/design tokens (no Tailwind) so it renders in any token-aware shell.
export function Transcript({ messages, isStreaming, onOption, leading }: TranscriptProps) {
	const viewportRef = useRef<HTMLDivElement>(null)
	const contentRef = useRef<HTMLDivElement>(null)
	// Chat-style "stick to bottom": auto-scroll only while the user is already at
	// the bottom. Reading back through history (scrolling up) detaches; returning
	// to the bottom re-attaches. Starts attached so the first paint lands on the
	// latest message.
	const stuckRef = useRef(true)
	// Last seen scrollTop, used to tell a user's upward scroll (the only thing that
	// detaches) apart from the downward moves that growth and auto-scroll cause.
	const lastTopRef = useRef(0)

	useLayoutEffect(() => {
		const viewport = viewportRef.current
		const content = contentRef.current
		if (!viewport || !content) return
		const toBottom = () => {
			viewport.scrollTop = viewport.scrollHeight
		}
		// Land at the bottom on first paint.
		toBottom()
		// Re-pin on any content height change — streamed text, a new bubble, an
		// expanded tool call — but only when the user hasn't scrolled away. Tracking
		// the content box (not message count) is what keeps streaming pinned, since
		// the array length is stable while the last message grows.
		const ro = new ResizeObserver(() => {
			if (stuckRef.current) toBottom()
		})
		ro.observe(content)
		return () => ro.disconnect()
	}, [])

	// Detach only on a genuine upward scroll: streamed growth and our own
	// scroll-to-bottom only ever move scrollTop down, so inferring "scrolled away"
	// from distance-to-bottom alone would mis-detach mid-stream when a chunk taller
	// than the slop lands before the scroll catches up. Re-attach once the bottom
	// is reached again (within slop, since a programmatic scroll lands just shy).
	const onScroll = () => {
		const el = viewportRef.current
		if (!el) return
		const top = el.scrollTop
		if (top < lastTopRef.current) stuckRef.current = false
		if (el.scrollHeight - top - el.clientHeight < 32) stuckRef.current = true
		lastTopRef.current = top
	}

	return (
		<div
			ref={viewportRef}
			onScroll={onScroll}
			className="js-transcript"
			// Disable browser scroll anchoring: we manage scrollTop ourselves, and an
			// anchoring nudge would register as a spurious upward scroll above.
			style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowAnchor: 'none' }}
		>
			<style>{css}</style>
			<div
				ref={contentRef}
				style={{
					display: 'flex',
					flexDirection: 'column',
					gap: '8px',
					padding: '12px'
				}}
			>
				{leading}
				{messages.map((m) => (
					<MessageItem key={m.id} message={m} isStreaming={isStreaming} onOption={onOption} />
				))}
			</div>
		</div>
	)
}

function MessageItem({
	message,
	isStreaming,
	onOption
}: {
	message: AgentMessage
	isStreaming: boolean
	onOption?: (label: string) => void
}) {
	if (message.source === 'app') {
		return <SystemRow label="From app" body={message.content} />
	}

	if (message.role === 'user') {
		return <Bubble side="right" content={message.content} streaming={false} />
	}

	if (message.error) {
		return <ErrorBlock body={message.content} />
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
			{message.options?.length ? (
				<OptionRows options={message.options} onOption={onOption} />
			) : null}
		</div>
	)
}

// A multiple-choice question's answers, rendered as a column of native-style push
// buttons under the assistant bubble. They sit on the opaque control surface (not
// the translucent bubble surface) so they read as controls, not messages; hover/
// active/focus states come from `.js-transcript-option` in the scoped sheet above.
// Picking one calls `onOption` (the host sends it as the next prompt); with no
// handler the rows still render, just inert.
function OptionRows(props: { options: { label: string }[]; onOption?: (label: string) => void }) {
	const { options, onOption } = props
	return (
		<div
			style={{
				display: 'flex',
				flexDirection: 'column',
				gap: '6px',
				alignItems: 'flex-start',
				marginTop: '2px'
			}}
		>
			{options.map((o) => (
				<button
					key={o.label}
					type="button"
					className={onOption ? 'js-transcript-option' : undefined}
					onClick={onOption ? () => onOption(o.label) : undefined}
					style={{
						maxWidth: '78%',
						textAlign: 'left',
						cursor: 'default',
						padding: '6px 12px',
						borderRadius: '6px',
						background: 'var(--control-bg)',
						border: '1px solid var(--rule)',
						boxShadow: '0 1px 1px rgba(0, 0, 0, 0.04)',
						color: 'var(--text)',
						font: 'inherit'
					}}
				>
					{o.label}
				</button>
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
				className="js-transcript-bubble"
				style={{
					position: 'relative',
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
				{content ? <CopyButton content={content} /> : null}
			</div>
		</div>
	)
}

// Hover-revealed copy control in the bubble's top-right corner. Visibility is
// driven by `.js-transcript-copy` in the scoped sheet above (hidden until the
// bubble is hovered or the button is focused). The icon inherits the bubble's
// text colour via currentColor, so it contrasts on both the user and assistant
// surfaces without per-side styling.
function CopyButton({ content }: { content: string }) {
	const [copied, setCopied] = useState(false)
	const copy = () => {
		void navigator.clipboard.writeText(content).then(() => {
			setCopied(true)
			setTimeout(() => setCopied(false), 1200)
		})
	}
	return (
		<button
			type="button"
			className="js-transcript-copy"
			onClick={copy}
			aria-label={copied ? 'Copied' : 'Copy message'}
			title={copied ? 'Copied' : 'Copy'}
			style={{
				position: 'absolute',
				top: '4px',
				right: '4px',
				display: 'inline-flex',
				alignItems: 'center',
				justifyContent: 'center',
				width: '20px',
				height: '20px',
				padding: 0,
				borderRadius: '5px',
				border: 'none',
				background: 'transparent',
				color: 'inherit',
				cursor: 'pointer'
			}}
		>
			{copied ? <CheckIcon /> : <CopyIcon />}
		</button>
	)
}

function CopyIcon() {
	return (
		<svg
			width="12"
			height="12"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<rect x="9" y="9" width="13" height="13" rx="2" />
			<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
		</svg>
	)
}

function CheckIcon() {
	return (
		<svg
			width="12"
			height="12"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M20 6L9 17l-5-5" />
		</svg>
	)
}

// A failed agent turn: an error-tinted block in the assistant's column. Reuses the
// same #dc2626 hue as a failed tool call so error state reads consistently on both
// themes (it's a literal, not a token, like the traffic-light controls).
function ErrorBlock({ body }: { body: string }) {
	return (
		<div style={{ display: 'flex', justifyContent: 'flex-start' }}>
			<div
				style={{
					maxWidth: '78%',
					whiteSpace: 'pre-wrap',
					overflowWrap: 'break-word',
					padding: '6px 12px',
					borderRadius: '14px',
					background: 'color-mix(in srgb, #dc2626 14%, var(--surface))',
					border: '1px solid color-mix(in srgb, #dc2626 40%, var(--rule))',
					color: 'var(--text)'
				}}
			>
				{body}
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
