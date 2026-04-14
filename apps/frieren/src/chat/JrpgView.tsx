import { useEffect, useRef, useState } from 'react'
import type { ChatViewProps } from './types'
import { ToolCallBlock } from './ToolCallBlock'
import { createTamagotchi, getSkinAvatarUrl, type TamagotchiHandle } from './tamagotchi'

const ROAM_HEIGHT = 96
const PORTRAIT_SIZE = 64
const skins = ['frieren', 'fern']
const ASSISTANT_SKIN_ID = skins[0]
const ASSISTANT_AVATAR_URL = getSkinAvatarUrl(ASSISTANT_SKIN_ID)

function AssistantAvatar(props: { size: number; className?: string }) {
	return (
		<img
			src={ASSISTANT_AVATAR_URL}
			alt="Assistant avatar"
			width={props.size}
			height={props.size}
			className={props.className}
			style={{ imageRendering: 'pixelated' }}
		/>
	)
}

export function JrpgView(props: ChatViewProps) {
	const { messages, input, setInput, connectionState, isStreaming, sendMessage, abort } = props
	const historyRef = useRef<HTMLDivElement>(null)
	const inputRef = useRef<HTMLTextAreaElement>(null)
	const canvasRef = useRef<HTMLCanvasElement>(null)
	const tamaRef = useRef<TamagotchiHandle | null>(null)

	const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
	const [pinnedId, setPinnedId] = useState<string | null>(null)
	const lastSeenAssistantIdRef = useRef<string | null>(null)
	const initializedRef = useRef(false)

	useEffect(() => {
		const id = lastAssistant?.id ?? null
		if (!initializedRef.current) {
			initializedRef.current = true
			lastSeenAssistantIdRef.current = id
			return
		}
		if (id && id !== lastSeenAssistantIdRef.current) {
			lastSeenAssistantIdRef.current = id
			setPinnedId(id)
		}
	}, [lastAssistant?.id])

	const pinned = pinnedId ? messages.find((m) => m.id === pinnedId) ?? null : null
	const showPanel = !!pinned
	const history = pinned ? messages.slice(0, messages.indexOf(pinned)) : messages

	const [focused, setFocused] = useState(false)
	const listening = (focused || input.length > 0) && !showPanel

	const dismissPanel = () => {
		setPinnedId(null)
		setTimeout(() => inputRef.current?.focus(), 0)
	}

	useEffect(() => {
		historyRef.current?.scrollTo({ top: historyRef.current.scrollHeight, behavior: 'smooth' })
	}, [history.length])

	useEffect(() => {
		if (!canvasRef.current) return
		const handle = createTamagotchi({ canvas: canvasRef.current, skinId: ASSISTANT_SKIN_ID })
		tamaRef.current = handle
		return () => {
			handle.destroy()
			tamaRef.current = null
		}
	}, [])

	useEffect(() => {
		const mode = showPanel ? 'talk' : listening ? 'listen' : 'roam'
		tamaRef.current?.setMode(mode)
	}, [showPanel, listening])

	const submit = () => {
		setPinnedId(null)
		sendMessage()
		inputRef.current?.focus()
	}

	return (
		<div className="relative mx-auto flex w-full max-w-3xl flex-1 flex-col overflow-hidden bg-gradient-to-b from-indigo-950 via-slate-900 to-slate-950 font-mono text-slate-100">
			<div ref={historyRef} className="flex flex-1 flex-col gap-3 overflow-y-auto px-6 py-4">
				{history.length === 0 ? (
					<div className="flex flex-1 items-center justify-center text-slate-500">
						<p>* A mysterious silence fills the air... *</p>
					</div>
				) : null}
				{history.map((message) => (
					<div key={message.id} className="flex flex-col gap-1">
						<div className={`flex items-start gap-3 ${message.role === 'assistant' ? 'flex-row-reverse' : ''}`}>
							<div
								className={`flex h-10 w-10 shrink-0 items-center justify-center border-2 border-double text-xl shadow-[3px_3px_0_rgba(0,0,0,0.6)] ${
									message.role === 'user'
										? 'border-amber-300 bg-amber-950 text-amber-100'
										: 'overflow-hidden border-sky-300 bg-indigo-950'
								}`}
							>
								{message.role === 'user' ? (
									'🗡️'
								) : (
									<AssistantAvatar size={40} className="h-full w-full object-cover object-center" />
								)}
							</div>
							<div
								className={`max-w-[75%] border-2 px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words shadow-[4px_4px_0_rgba(0,0,0,0.6)] ${
									message.role === 'user'
										? 'border-amber-300 bg-slate-900/90 text-amber-100'
										: 'border-sky-300 bg-slate-900/90 text-sky-100'
								}`}
							>
								<div className="mb-1 text-[10px] uppercase tracking-widest opacity-70">
									{message.role === 'user' ? '> Hero' : '> Frieren'}
								</div>
								{message.content}
							</div>
						</div>
						{message.toolCalls && message.toolCalls.length > 0 ? (
							<div className="ml-14 flex flex-col gap-1">
								{message.toolCalls.map((toolCall) => (
									<ToolCallBlock key={toolCall.id} toolCall={toolCall} />
								))}
							</div>
						) : null}
					</div>
				))}
			</div>

			<div className="relative">
				<canvas
					ref={canvasRef}
					onClick={() => tamaRef.current?.poke()}
					className="block w-full cursor-pointer border-t-4 border-double border-sky-300/40"
					style={{ height: ROAM_HEIGHT, imageRendering: 'pixelated' }}
				/>

				<div className="border-t-4 border-double border-sky-300/60 bg-slate-950/80 p-4">
					<div className="flex gap-3">
						{!showPanel ? (
							<div
								className="flex shrink-0 items-center justify-center border-4 border-double border-amber-300 bg-amber-950 text-3xl text-amber-100 shadow-[4px_4px_0_rgba(0,0,0,0.6)]"
								style={{ width: PORTRAIT_SIZE, height: PORTRAIT_SIZE }}
							>
	🗡️
							</div>
						) : null}
						<div
							className={`flex-1 border-4 border-double border-sky-300 bg-slate-900 p-3 shadow-[6px_6px_0_rgba(0,0,0,0.6)] ${showPanel ? 'cursor-pointer hover:border-amber-300' : ''}`}
							onClick={showPanel && !isStreaming ? dismissPanel : undefined}
						>
							{showPanel && pinned ? (
								<div>
									<div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-widest text-sky-300/80">
										<span>* Frieren *</span>
										{isStreaming ? (
											<button
												type="button"
												className="text-rose-300 hover:underline"
												onClick={(event) => {
													event.stopPropagation()
													abort()
												}}
											>
	[stop]
											</button>
										) : (
											<span className="text-amber-300/80">[click to reply ▸]</span>
										)}
									</div>
									<div className="min-h-[3.5rem] whitespace-pre-wrap break-words text-sm leading-relaxed text-sky-100">
										{pinned.content || <span className="opacity-60">...</span>}
										{isStreaming ? (
											<span className="ml-px inline-block h-[1em] w-1 animate-pulse bg-sky-200 align-text-bottom" />
										) : null}
									</div>
									{pinned.toolCalls && pinned.toolCalls.length > 0 ? (
										<div className="mt-2 flex flex-col gap-1">
											{pinned.toolCalls.map((toolCall) => (
												<ToolCallBlock key={toolCall.id} toolCall={toolCall} />
											))}
										</div>
									) : null}
								</div>
							) : (
								<form
									onSubmit={(event) => {
										event.preventDefault()
										submit()
									}}
								>
									<div className="mb-1 text-[10px] uppercase tracking-widest text-amber-300/80">
	* Hero * {connectionState !== 'ready' ? `[${connectionState}]` : ''}
									</div>
									<textarea
										ref={inputRef}
										className="min-h-[3.5rem] w-full resize-none bg-transparent text-sm leading-relaxed text-amber-100 placeholder:text-slate-500 focus:outline-none"
										value={input}
										onChange={(event) => setInput(event.target.value)}
										onFocus={() => setFocused(true)}
										onBlur={() => setFocused(false)}
										onKeyDown={(event) => {
											if (event.key === 'Enter' && !event.shiftKey) {
												event.preventDefault()
												submit()
											}
										}}
										placeholder={connectionState === 'ready' ? 'What will you say?' : 'Connecting...'}
										disabled={connectionState !== 'ready'}
										rows={2}
									/>
									<div className="flex justify-end text-[10px] text-slate-500">
	▼ ENTER to speak
									</div>
								</form>
							)}
						</div>
						{showPanel ? (
							<div
								className="shrink-0 overflow-hidden border-4 border-double border-sky-300 bg-indigo-950 shadow-[4px_4px_0_rgba(0,0,0,0.6)]"
								style={{ width: PORTRAIT_SIZE, height: PORTRAIT_SIZE }}
							>
								<AssistantAvatar size={PORTRAIT_SIZE} className="h-full w-full object-cover object-center" />
							</div>
						) : null}
					</div>
				</div>
			</div>
		</div>
	)
}
