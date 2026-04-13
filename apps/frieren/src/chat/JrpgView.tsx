import { useEffect, useRef, useState } from 'react'
import type { ChatViewProps } from './types'
import { ToolCallBlock } from './ToolCallBlock'

const ROAM_HEIGHT = 96
const PORTRAIT_SIZE = 64

export function JrpgView(props: ChatViewProps) {
	const { messages, input, setInput, connectionState, isStreaming, sendMessage, abort } = props
	const historyRef = useRef<HTMLDivElement>(null)
	const inputRef = useRef<HTMLTextAreaElement>(null)
	const roamRef = useRef<HTMLDivElement>(null)

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
	const roaming = !listening && !showPanel

	const dismissPanel = () => {
		setPinnedId(null)
		setTimeout(() => inputRef.current?.focus(), 0)
	}

	const [pos, setPos] = useState({ x: 40, y: ROAM_HEIGHT / 2 })
	const [target, setTarget] = useState({ x: 40, y: ROAM_HEIGHT / 2 })
	const [facing, setFacing] = useState<'left' | 'right'>('right')

	useEffect(() => {
		historyRef.current?.scrollTo({ top: historyRef.current.scrollHeight, behavior: 'smooth' })
	}, [history.length])

	useEffect(() => {
		if (!roaming) return
		const pick = () => {
			const el = roamRef.current
			if (!el) return
			const w = el.clientWidth
			setTarget({
				x: 30 + Math.random() * Math.max(40, w - 60),
				y: 15 + Math.random() * Math.max(10, ROAM_HEIGHT - 30)
			})
		}
		pick()
		const id = setInterval(pick, 2200)
		return () => clearInterval(id)
	}, [roaming])

	useEffect(() => {
		let raf = 0
		const step = () => {
			setPos((current) => {
				let goal = target
				let speed = 0.025
				if (listening) {
					const el = roamRef.current
					const w = el ? el.clientWidth : 300
					goal = { x: w / 2, y: ROAM_HEIGHT / 2 }
					speed = 0.12
				} else if (showPanel) {
					const el = roamRef.current
					const w = el ? el.clientWidth : 300
					goal = { x: w - 16 - PORTRAIT_SIZE / 2, y: ROAM_HEIGHT + 16 + PORTRAIT_SIZE / 2 }
					speed = 0.12
				}
				const dx = goal.x - current.x
				const dy = goal.y - current.y
				if (Math.abs(dx) < 0.3 && Math.abs(dy) < 0.3) return current
				if (dx > 0.3) setFacing('right')
				else if (dx < -0.3) setFacing('left')
				return { x: current.x + dx * speed, y: current.y + dy * speed }
			})
			raf = requestAnimationFrame(step)
		}
		raf = requestAnimationFrame(step)
		return () => cancelAnimationFrame(raf)
	}, [target, listening, showPanel])

	const submit = () => {
		setPinnedId(null)
		sendMessage()
		inputRef.current?.focus()
	}

	const scale = showPanel ? 1.25 : listening ? 1.15 : 1
	const bob = showPanel ? 'animate-[bob_0.6s_ease-in-out_infinite]' : 'animate-[bob_1.4s_ease-in-out_infinite]'

	return (
		<div className="relative mx-auto flex w-full max-w-3xl flex-1 flex-col overflow-hidden bg-gradient-to-b from-indigo-950 via-slate-900 to-slate-950 font-mono text-slate-100">
			<style>{`
				@keyframes bob {
					0%, 100% { transform: translateY(0); }
					50% { transform: translateY(-3px); }
				}
			`}</style>

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
										: 'border-sky-300 bg-indigo-900 text-sky-100'
								}`}
							>
								{message.role === 'user' ? '🗡️' : '🧝'}
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
				<div
					ref={roamRef}
					className="relative overflow-hidden border-t-4 border-double border-sky-300/40"
					style={{ height: ROAM_HEIGHT }}
				>
					<div className="pointer-events-none absolute inset-0 opacity-30" style={{
						backgroundImage: 'radial-gradient(circle at 30% 50%, rgba(125,211,252,0.25), transparent 55%), radial-gradient(circle at 75% 50%, rgba(167,139,250,0.2), transparent 55%)'
					}} />
				</div>

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
							<div style={{ width: PORTRAIT_SIZE, height: PORTRAIT_SIZE }} className="shrink-0" />
						) : null}
					</div>
				</div>

				<div
					className="pointer-events-none absolute"
					style={{
						left: pos.x,
						top: pos.y,
						transform: `translate(-50%, -50%) scale(${scale}) scaleX(${facing === 'left' ? -1 : 1})`,
						transition: 'transform 0.2s ease-out'
					}}
				>
					<div className={`text-4xl ${bob}`}>
						{showPanel ? '🧝‍♀️' : listening ? '👂' : '🧝'}
					</div>
				</div>
			</div>
		</div>
	)
}
