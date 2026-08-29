import '@justfiles/design/design.css'
import '@justfiles/design/mac.css'
import { BUILTIN_AVATARS } from '@justfiles/agent/avatars'
import { AttachedAgent, type AttachedAgentMode } from '@justfiles/ui/AttachedAgent'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
	type AttachedAgentChange,
	type AttachedAgentClientMessage,
	type AttachedAgentServerMessage,
	type AttachedAgentState,
	changeAttachedAgentState,
	initialAttachedAgentState
} from '../../attached-agent'
import { AttachedChat } from './AttachedChat'
import './attached-agent.css'

const host = document.getElementById('host')
if (!host) throw new Error('Missing #host')

const appId = decodeURIComponent(location.pathname.split('/').at(-1) ?? '')

// A minimal request/response + state-push channel over one WebSocket. The GUI's
// generated client only ever does flat `invoke({type,params})` and `subscribe`,
// so there's no RPC framework here: calls are correlated by `id`, and the server
// pushes authoritative state frames (the initial snapshot on connect, then every
// update via Bun pub/sub) which we hand to the subscriber.
type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void }

function connect(appId: string) {
	const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
	const ws = new WebSocket(
		`${protocol}://${location.host}/app/${encodeURIComponent(appId)}/connect`
	)
	const pending = new Map<number, Pending>()
	let seq = 0
	let onState: ((state: unknown) => void) | undefined
	let onAssistant: ((state: AttachedAgentState) => void) | undefined
	let last: unknown
	let got = false
	let lastAssistant = initialAttachedAgentState
	let gotAssistant = false
	let resolveFirst!: (state: unknown) => void
	let resolveAssistant!: (state: AttachedAgentState) => void
	const first = new Promise<unknown>((r) => (resolveFirst = r))
	const assistant = new Promise<AttachedAgentState>((r) => (resolveAssistant = r))
	const opened = new Promise<void>((r) => (ws.onopen = () => r()))

	ws.onmessage = (e) => {
		const msg = JSON.parse(String(e.data)) as Record<string, unknown>
		if ('assistant' in msg) {
			lastAssistant = (msg as AttachedAgentServerMessage).assistant
			if (!gotAssistant) {
				gotAssistant = true
				resolveAssistant(lastAssistant)
			}
			onAssistant?.(lastAssistant)
			return
		}
		if (msg.reload === true) {
			location.reload()
			return
		}
		if ('id' in msg) {
			const reply = msg as { id: number; ok: boolean; value?: unknown; error?: string }
			const p = pending.get(reply.id)
			if (!p) return
			pending.delete(reply.id)
			if (reply.ok) p.resolve(reply.value)
			else p.reject(new Error(reply.error))
			return
		}
		last = msg.state
		if (!got) {
			got = true
			resolveFirst(msg.state)
		}
		onState?.(msg.state)
	}

	const transport = {
		async invoke(message: { type: string; params: unknown }) {
			await opened
			const id = ++seq
			return new Promise<unknown>((resolve, reject) => {
				pending.set(id, { resolve, reject })
				ws.send(JSON.stringify({ id, ...message }))
			})
		},
		subscribe(cb: (state: unknown) => void) {
			onState = cb
			if (got) cb(last) // flush the snapshot received before mount
			return () => {
				if (onState === cb) onState = undefined
			}
		}
	}

	return {
		transport,
		first,
		assistant,
		subscribeAssistant(cb: (state: AttachedAgentState) => void) {
			onAssistant = cb
			if (gotAssistant) cb(lastAssistant)
			return () => {
				if (onAssistant === cb) onAssistant = undefined
			}
		},
		changeAssistant(change: AttachedAgentChange) {
			ws.send(
				JSON.stringify({ shell: 'attached-agent', change } satisfies AttachedAgentClientMessage)
			)
		}
	}
}

const connection = connect(appId)
// The gui.js is served by the daemon at this absolute URL at runtime; @vite-ignore stops
// Vite from trying to statically analyze (and warn about) the dynamic specifier.
const [app, state, savedAssistant] = await Promise.all([
	import(/* @vite-ignore */ `/app/${appId}/gui.js`),
	connection.first,
	connection.assistant
])

function AppRoot() {
	const root = useRef<HTMLDivElement>(null)

	useEffect(() => {
		if (!root.current) return
		const mounted = app.gui.mount(root.current, state, { transport: connection.transport })
		return () => void mounted.unmount()
	}, [])

	return <div id="root" ref={root} />
}

function AppHost() {
	const [assistant, setAssistant] = useState(savedAssistant)
	const [sheetOpen, setSheetOpen] = useState(false)
	const [panelMode, setPanelMode] = useState<AttachedAgentMode>('sheet')
	const [sidebarReady, setSidebarReady] = useState(false)
	const [streaming, setStreaming] = useState(false)

	useEffect(() => connection.subscribeAssistant(setAssistant), [])

	const save = useCallback((change: AttachedAgentChange) => {
		setAssistant((state) => changeAttachedAgentState(state, appId, change))
		connection.changeAssistant(change)
	}, [])
	const sidebarOpen = Boolean(assistant.open[appId])
	const requestedOpen =
		panelMode === 'sidebar' ? sidebarOpen : sheetOpen || (sidebarReady && sidebarOpen)
	const open = requestedOpen || streaming
	const trackMode = useCallback(
		(mode: AttachedAgentMode) => {
			setPanelMode(mode)
			if (mode !== 'sidebar') return
			setSidebarReady(true)
			if (sheetOpen) {
				setSheetOpen(false)
				save({ open: true })
			}
		},
		[save, sheetOpen]
	)

	return (
		<AttachedAgent
			agent={{
				mode: assistant.mode,
				open,
				size: assistant.size,
				footer: (
					<img
						className="mac-attached-agent-face"
						src={BUILTIN_AVATARS.vanilla?.resting}
						alt=""
						width="16"
						height="16"
					/>
				),
				panel: open ? <AttachedChat appId={appId} onStreamingChange={setStreaming} /> : null,
				onModeChange: (mode) => {
					setPanelMode(mode)
					if (mode === 'sheet') {
						setSheetOpen(open)
						save({ mode, open: false })
					} else {
						setSheetOpen(false)
						save({ mode, open })
					}
				},
				onEffectiveModeChange: trackMode,
				onOpenChange: (next) => {
					if (!next && streaming) return
					if (panelMode === 'sidebar') save({ open: next })
					else {
						setSheetOpen(next)
						if (sidebarReady) save({ open: next })
					}
				},
				onSizeChange: (size) => save({ size })
			}}
		>
			<AppRoot />
		</AttachedAgent>
	)
}

createRoot(host).render(<AppHost />)
