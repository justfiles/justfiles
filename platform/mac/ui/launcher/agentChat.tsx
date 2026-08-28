import type {
	ActivityDetailResult,
	SessionClientMessage,
	SessionServerMessage,
	TranscriptItem,
	TranscriptStatus
} from '@justfiles/agent/protocol'
import type { TranscriptRow } from '@justfiles/ui/Transcript'
import { useCallback, useEffect, useRef, useState } from 'react'

// The launcher's agent transport: a plain WebSocket to the daemon's `/agent` socket, which
// is a live view of the shared session. The daemon sends a snapshot, then pushes durable
// items and current status, including work started by `/skill`. Shared by the in-page
// launcher chat (main.tsx) and the native chat surface (chat.tsx). Commands are NOT sent here — they ride
// `/system` and reach the agent (if at all) as a skill, surfacing naturally in the push.

type Connection = 'connecting' | 'ready' | 'disconnected'

export function useAgentChat() {
	const [messages, setMessages] = useState<TranscriptRow[]>([])
	const [isStreaming, setIsStreaming] = useState(false)
	const [connection, setConnection] = useState<Connection>('connecting')
	const [error, setError] = useState<string | null>(null)
	const socketRef = useRef<WebSocket | null>(null)
	const historyRef = useRef<readonly TranscriptItem[]>([])
	const statusRef = useRef<TranscriptStatus>({ state: 'idle' })
	const submittingRef = useRef(false)
	const pendingMessageRef = useRef<string | null>(null)
	const pendingDetailsRef = useRef(new Map<string, (result: ActivityDetailResult) => void>())

	const setStatus = useCallback((status: TranscriptStatus) => {
		statusRef.current = status
		setIsStreaming(submittingRef.current || status.state !== 'idle')
	}, [])

	const setSubmitting = useCallback((submitting: boolean) => {
		submittingRef.current = submitting
		setIsStreaming(submitting || statusRef.current.state !== 'idle')
	}, [])

	const replaceHistory = useCallback((history: readonly TranscriptItem[]) => {
		historyRef.current = history
		setMessages([...history])
	}, [])

	// Subscribe to the live session, reconnecting on drop. A daemon restart sends fresh state.
	useEffect(() => {
		let stopped = false
		let retry: ReturnType<typeof setTimeout> | undefined
		let socket: WebSocket | undefined
		const connect = () => {
			setConnection('connecting')
			const nextSocket = new WebSocket(
				`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/agent`
			)
			socket = nextSocket
			socketRef.current = nextSocket
			nextSocket.onmessage = (ev) => {
				if (socketRef.current !== nextSocket) return
				const message = JSON.parse(String(ev.data)) as SessionServerMessage
				if (message.type === 'activity_detail') {
					pendingDetailsRef.current.get(message.requestId)?.(message.result)
					pendingDetailsRef.current.delete(message.requestId)
				} else if (message.type === 'snapshot') {
					replaceHistory(message.history)
					setSubmitting(false)
					setStatus(message.status)
					setConnection('ready')
					setError(null)
				} else if (message.type === 'item') {
					replaceHistory([...historyRef.current, message.item])
				} else if (message.type === 'status') {
					setStatus(message.status)
					if (message.status.state === 'idle') replaceHistory(historyRef.current)
					if (message.error) {
						const error = message.error
						setMessages((messages) => [
							...messages,
							{
								id: crypto.randomUUID(),
								role: 'assistant',
								content: error.message,
								error: true
							}
						])
					}
				} else if (message.type === 'accepted' || message.type === 'rejected') {
					setSubmitting(false)
					if (message.type === 'rejected' && pendingMessageRef.current) {
						const id = pendingMessageRef.current
						setMessages((messages) => messages.filter((message) => message.id !== id))
					}
					pendingMessageRef.current = null
				}
			}
			nextSocket.onerror = () => nextSocket.close()
			nextSocket.onclose = () => {
				if (stopped || socketRef.current !== nextSocket) return
				socketRef.current = null
				setSubmitting(false)
				setStatus({ state: 'idle' })
				replaceHistory(historyRef.current)
				for (const resolve of pendingDetailsRef.current.values()) resolve({ status: 'expired' })
				pendingDetailsRef.current.clear()
				setConnection('disconnected')
				retry = setTimeout(connect, 1000)
			}
		}
		connect()
		return () => {
			stopped = true
			clearTimeout(retry)
			socket?.close()
			for (const resolve of pendingDetailsRef.current.values()) resolve({ status: 'expired' })
			pendingDetailsRef.current.clear()
		}
	}, [replaceHistory, setStatus, setSubmitting])

	const send = useCallback(
		(text: string) => {
			const trimmed = text.trim()
			const socket = socketRef.current
			if (
				!trimmed ||
				!socket ||
				socket.readyState !== WebSocket.OPEN ||
				submittingRef.current ||
				statusRef.current.state !== 'idle'
			)
				return
			setSubmitting(true)
			setError(null)
			const id = crypto.randomUUID()
			pendingMessageRef.current = id
			setMessages((messages) => [
				...messages,
				{
					id,
					role: 'user',
					content: trimmed
				}
			])
			socket.send(JSON.stringify({ type: 'prompt', text: trimmed } satisfies SessionClientMessage))
		},
		[setSubmitting]
	)

	const abort = useCallback(() => {
		const socket = socketRef.current
		if (statusRef.current.state === 'idle' || !socket || socket.readyState !== WebSocket.OPEN)
			return
		socket.send(JSON.stringify({ type: 'abort' } satisfies SessionClientMessage))
	}, [])

	const loadActivityDetail = useCallback((detailId: string): Promise<ActivityDetailResult> => {
		const socket = socketRef.current
		if (!socket || socket.readyState !== WebSocket.OPEN)
			return Promise.resolve({ status: 'expired' })
		const requestId = crypto.randomUUID()
		const result = new Promise<ActivityDetailResult>((resolve) => {
			pendingDetailsRef.current.set(requestId, resolve)
		})
		socket.send(
			JSON.stringify({
				type: 'activity_detail',
				requestId,
				detailId
			} satisfies SessionClientMessage)
		)
		return result
	}, [])

	return { messages, isStreaming, connection, error, send, abort, loadActivityDetail }
}
