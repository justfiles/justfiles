import {
	type CSSProperties,
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useRef,
	useState
} from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

// A tool-produced image, referenced by a host-meaningful `src` (a Volume path on
// frieren, a daemon route on quay) — never inline bytes. The host's `resolveImage`
// turns it into a displayable URL.
export interface TranscriptImage {
	src: string
	mimeType?: string
	alt?: string
}

export interface ToolCallInfo {
	id: string
	name: string
	args: unknown
	result?: unknown
	isError?: boolean
	status: 'running' | 'done'
	// Images this tool produced; promoted out of the collapsed row to inline cards.
	images?: TranscriptImage[]
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
	// Resolve a TranscriptImage to a displayable URL (blob:/https:), or null when
	// the bytes are unavailable. Omitted hosts render no inline images.
	resolveImage?: (image: TranscriptImage) => Promise<string | null>
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
.js-transcript-md > :first-child { margin-top: 0; }
.js-transcript-md > :last-child { margin-bottom: 0; }
.js-transcript-md p { margin: 0 0 0.5em; }
.js-transcript-md ul, .js-transcript-md ol { margin: 0 0 0.5em; padding-left: 1.4em; }
.js-transcript-md li { margin: 0.15em 0; }
.js-transcript-md li > p { margin: 0; }
.js-transcript-md h1, .js-transcript-md h2, .js-transcript-md h3,
.js-transcript-md h4, .js-transcript-md h5, .js-transcript-md h6 {
	margin: 0.6em 0 0.3em; font-weight: 600; line-height: 1.3;
}
.js-transcript-md h1 { font-size: 1.3em; }
.js-transcript-md h2 { font-size: 1.15em; }
.js-transcript-md h3 { font-size: 1.05em; }
.js-transcript-md h4, .js-transcript-md h5, .js-transcript-md h6 { font-size: 1em; }
.js-transcript-md code {
	font-family: var(--font-mono);
	font-size: 0.9em;
	padding: 0.1em 0.35em;
	border-radius: 4px;
	background: color-mix(in srgb, currentColor 12%, transparent);
}
.js-transcript-md pre {
	margin: 0 0 0.5em;
	padding: 8px 10px;
	max-width: 100%;
	overflow-x: auto;
	border-radius: 8px;
	background: var(--surface);
	border: 1px solid var(--rule);
}
.js-transcript-md pre code {
	padding: 0;
	border-radius: 0;
	background: none;
	font-size: 0.85em;
	white-space: pre;
}
.js-transcript-md a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
.js-transcript-md blockquote {
	margin: 0 0 0.5em;
	padding-left: 0.8em;
	border-left: 2px solid var(--rule);
	opacity: 0.85;
}
.js-transcript-md table { border-collapse: collapse; margin: 0 0 0.5em; font-size: 0.9em; }
.js-transcript-md th, .js-transcript-md td { padding: 3px 8px; border: 1px solid var(--rule); }
.js-transcript-md hr { margin: 0.6em 0; border: none; border-top: 1px solid var(--rule); }
.js-transcript-md img { max-width: 100%; border-radius: 6px; }
`

// Presentation-only agent transcript: a scrolling message history with bubbles,
// collapsible thinking / tool-call rows, and a streaming caret. Transport-
// agnostic — the host owns the session, header, and composer. Styled on
// @justfiles/design tokens (no Tailwind) so it renders in any token-aware shell.
export function Transcript({
	messages,
	isStreaming,
	onOption,
	leading,
	resolveImage
}: TranscriptProps) {
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
					<MessageItem
						key={m.id}
						message={m}
						isStreaming={isStreaming}
						onOption={onOption}
						resolveImage={resolveImage}
					/>
				))}
			</div>
		</div>
	)
}

function MessageItem({
	message,
	isStreaming,
	onOption,
	resolveImage
}: {
	message: AgentMessage
	isStreaming: boolean
	onOption?: (label: string) => void
	resolveImage?: (image: TranscriptImage) => Promise<string | null>
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
			{resolveImage
				? message.toolCalls?.flatMap(
						(tc) =>
							tc.images?.map((image) => (
								<ImageCard
									key={`${tc.id}:${image.src}`}
									image={image}
									resolveImage={resolveImage}
								/>
							)) ?? []
					)
				: null}
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
					// Assistant text is markdown (its blocks own their spacing); user text is
					// shown verbatim, so its newlines are preserved.
					whiteSpace: isUser ? 'pre-wrap' : 'normal',
					overflowWrap: 'break-word',
					padding: '6px 12px',
					borderRadius: '14px',
					background: isUser ? 'var(--focus)' : 'var(--surface-subtle)',
					color: isUser ? 'var(--on-focus)' : 'var(--text)'
				}}
			>
				{isUser ? content : <MarkdownContent content={content} />}
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

// Assistant bubbles render their text as Markdown — LLM output is Markdown by
// convention (fenced code, lists, tables), and plain prose is valid Markdown
// that renders unchanged, so no "is this Markdown?" detection is needed. Raw
// HTML is not enabled (no rehype-raw), so agent output can't inject markup.
// Styling lives in the scoped sheet above (`.js-transcript-md`) so element
// margins and code/pre monospace follow the design tokens.
const markdownComponents: Components = {
	a({ node: _node, ...props }) {
		// Links must escape the transcript's frame, not navigate the host away.
		return <a {...props} target="_blank" rel="noopener noreferrer" />
	},
	img({ alt }) {
		// Markdown images carry agent-authored URLs; rendering a live <img> would fire
		// an arbitrary GET (tracking / SSRF via prompt injection) and bypass the
		// resolveImage contract, under which only host-vouched tool images render
		// inline. Show the alt text rather than loading anything.
		return alt ? <span style={{ opacity: 0.6 }}>{alt}</span> : null
	}
}

function MarkdownContent({ content }: { content: string }) {
	return (
		<div className="js-transcript-md">
			<ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
				{content}
			</ReactMarkdown>
		</div>
	)
}

// An inline image in the assistant column, promoted out of the collapsed tool
// row. Resolution is async (the host may read a Volume or hit a byte route), so
// the card renders a quiet placeholder until the URL lands; an unresolvable ref
// (e.g. the user deleted the file) degrades to a muted note instead of a broken
// <img>. A miss keeps retrying while the card is on screen — the bytes may just
// not have reached this host yet — so a late arrival upgrades the note in place.
const IMAGE_RETRY_MS = 30_000

function ImageCard({
	image,
	resolveImage
}: {
	image: TranscriptImage
	resolveImage: (image: TranscriptImage) => Promise<string | null>
}) {
	const [url, setUrl] = useState<string | null | undefined>(undefined)
	useEffect(() => {
		let alive = true
		let timer: ReturnType<typeof setTimeout> | undefined
		const attempt = () => {
			resolveImage(image).then(
				(resolved) => {
					if (!alive) return
					setUrl(resolved)
					if (resolved === null) timer = setTimeout(attempt, IMAGE_RETRY_MS)
				},
				() => {
					if (!alive) return
					setUrl(null)
					timer = setTimeout(attempt, IMAGE_RETRY_MS)
				}
			)
		}
		setUrl(undefined)
		attempt()
		return () => {
			alive = false
			if (timer) clearTimeout(timer)
		}
	}, [image, resolveImage])

	if (url === null) {
		return (
			<div style={{ fontSize: '11px', opacity: 0.5, padding: '2px 8px' }}>
				Image unavailable ({image.src})
			</div>
		)
	}
	return (
		<div style={{ display: 'flex', justifyContent: 'flex-start' }}>
			{url === undefined ? (
				<div
					style={{
						width: '160px',
						height: '120px',
						borderRadius: '10px',
						background: 'var(--surface-subtle)'
					}}
				/>
			) : (
				<img
					src={url}
					alt={image.alt ?? ''}
					title={image.alt}
					style={{
						maxWidth: '78%',
						maxHeight: '320px',
						borderRadius: '10px',
						border: '1px solid var(--rule)'
					}}
				/>
			)}
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
