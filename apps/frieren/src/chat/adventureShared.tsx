import { useEffect, useRef, useState } from 'react'
import { createTamagotchi, getSkinAvatarUrl, type TamagotchiHandle } from './tamagotchi'
import type { ChatMessage } from './types'

export const ROAM_HEIGHT = 96
export const PORTRAIT_SIZE = 64

const skins = ['frieren', 'fern']
const ASSISTANT_SKIN_ID = skins[0]
const ASSISTANT_AVATAR_URL = getSkinAvatarUrl(ASSISTANT_SKIN_ID)

export function AssistantAvatar(props: { size: number; className?: string }) {
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

export function useAdventureViewState(props: {
	messages: ChatMessage[]
	input: string
	sendMessage: () => void
}) {
	const { messages, input, sendMessage } = props
	const historyRef = useRef<HTMLDivElement>(null)
	const inputRef = useRef<HTMLTextAreaElement>(null)
	const canvasRef = useRef<HTMLCanvasElement>(null)
	const tamaRef = useRef<TamagotchiHandle | null>(null)

	const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant')
	const [pinnedId, setPinnedId] = useState<string | null>(null)
	const lastSeenAssistantIdRef = useRef<string | null>(null)
	const initializedRef = useRef(false)
	const [focused, setFocused] = useState(false)

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

	const pinned = pinnedId ? (messages.find((message) => message.id === pinnedId) ?? null) : null
	const showPanel = !!pinned
	const history = pinned ? messages.slice(0, messages.indexOf(pinned)) : messages
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

	return {
		canvasRef,
		dismissPanel,
		history,
		historyRef,
		inputRef,
		pinned,
		poke: () => tamaRef.current?.poke(),
		setFocused,
		showPanel,
		submit
	}
}
