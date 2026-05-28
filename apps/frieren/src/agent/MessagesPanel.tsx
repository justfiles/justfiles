import { useLayoutEffect, useRef } from 'react'
import agentAvatarUrl from './agent-avatar.png'
import { useAgentConnection, useAgentSession } from './hooks'
import type { AgentMessage, ToolCallInfo } from './types'

// OS-level agent surface — invoked from the menubar, not the app launcher.
// The agent is part of the OS, not an app, so this component consumes the
// agent session directly. Wrap it in a window (or whatever shell the host
// decides) at the caller; the panel itself is presentation-only.
export function MessagesPanel() {
	const session = useAgentSession()
	const connection = useAgentConnection()
	const { messages, input, setInput, userName, agentName, isStreaming, sendMessage, abort } =
		session
	const ready = connection.state === 'ready'
	const historyRef = useRef<HTMLDivElement>(null)
	const inputRef = useRef<HTMLTextAreaElement>(null)

	useLayoutEffect(() => {
		void messages.length
		const el = historyRef.current
		if (el) el.scrollTop = el.scrollHeight
	}, [messages.length])

	const submit = () => {
		sendMessage()
		inputRef.current?.focus()
	}

	return (
		<div
			className="flex h-full w-full flex-col"
			style={{
				background: '#ffffff',
				color: 'var(--text)',
				fontFamily: 'var(--font-ui)',
				fontSize: 'var(--text-ui)'
			}}
		>
			<header
				className="flex flex-none flex-col items-center gap-1 px-3 py-3"
				style={{ background: 'var(--surface)', borderBottom: '1px solid var(--rule)' }}
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

			<div ref={historyRef} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
				{messages.length === 0 ? (
					<div className="m-auto text-xs opacity-50">Say something to {agentName}.</div>
				) : (
					messages.map((m) => (
						<MessageItem key={m.id} message={m} userName={userName} isStreaming={isStreaming} />
					))
				)}
			</div>

			<form
				className="flex flex-none items-end gap-2 px-3 py-2"
				style={{ borderTop: '1px solid var(--rule)', background: 'var(--surface)' }}
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
						background: '#ffffff',
						border: '1px solid var(--rule)',
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

function MessageItem(props: { message: AgentMessage; userName: string; isStreaming: boolean }) {
	const { message, isStreaming } = props

	if (message.source === 'app') {
		return <SystemRow label="From app" body={message.content} />
	}

	if (message.role === 'user') {
		return <Bubble side="right" content={message.content} streaming={false} />
	}

	const showCursor = isStreaming && !message.content && !message.toolCalls?.length
	return (
		<div className="flex flex-col gap-1">
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
		<div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
			<div
				className="max-w-[78%] whitespace-pre-wrap break-words px-3 py-1.5"
				style={{
					background: isUser ? 'var(--focus)' : '#e5e5ea',
					color: isUser ? 'var(--on-focus)' : 'var(--text)',
					borderRadius: '14px'
				}}
			>
				{content}
				{streaming ? (
					<span className="ml-px inline-block h-[1em] w-0.5 animate-pulse bg-current align-text-bottom" />
				) : null}
			</div>
		</div>
	)
}

function SystemRow(props: { label: string; body: string; mono?: boolean }) {
	return (
		<details className="self-center text-[11px] opacity-60">
			<summary className="cursor-pointer list-none px-2 py-0.5 marker:hidden [&::-webkit-details-marker]:hidden">
				<span className="uppercase tracking-wide">{props.label}</span>
			</summary>
			<pre
				className={`mt-1 max-h-48 max-w-[80ch] overflow-auto whitespace-pre-wrap break-words rounded px-2 py-1 ${
					props.mono === false ? '' : 'font-mono'
				}`}
				style={{ background: 'var(--surface)', border: '1px solid var(--rule)' }}
			>
				{props.body}
			</pre>
		</details>
	)
}

function ToolCallRow(props: { call: ToolCallInfo }) {
	const { call } = props
	const dot = call.status === 'running' ? '#f59e0b' : call.isError ? '#dc2626' : 'rgba(0,0,0,0.35)'
	const args = call.args === undefined ? null : JSON.stringify(call.args, null, 2)
	const result = call.result === undefined ? null : JSON.stringify(call.result, null, 2)
	return (
		<details className="self-center text-[11px] opacity-70">
			<summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-0.5 marker:hidden [&::-webkit-details-marker]:hidden">
				<span
					role="img"
					aria-label={call.status === 'running' ? 'running' : call.isError ? 'error' : 'done'}
					className="inline-block size-1.5 rounded-full"
					style={{ background: dot }}
				/>
				<span className="font-mono">{call.name}</span>
			</summary>
			<div className="mt-1 flex max-w-[80ch] flex-col gap-1">
				{args !== null ? (
					<pre
						className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded px-2 py-1 font-mono"
						style={{ background: 'var(--surface)', border: '1px solid var(--rule)' }}
					>
						{args}
					</pre>
				) : null}
				{result !== null ? (
					<pre
						className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded px-2 py-1 font-mono"
						style={{
							background: call.isError ? '#fee2e2' : 'var(--surface)',
							border: '1px solid var(--rule)'
						}}
					>
						{result}
					</pre>
				) : null}
			</div>
		</details>
	)
}
