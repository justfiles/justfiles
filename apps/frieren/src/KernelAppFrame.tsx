import { useAuth } from '@clerk/clerk-react'
import { HouseIcon } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'

// SDK shapes — duplicated locally to keep this frame free of an SDK type
// import (the SDK is bundled into the app, not imported by the host).
interface Transport {
	invoke(action: { type: string; params: unknown }): Promise<unknown>
	subscribe(onState: (state: unknown) => void): () => void
}

interface GuiInstance {
	update(state: unknown): Promise<void> | void
	unmount(): Promise<void> | void
}

interface GuiModule {
	gui: {
		mount(el: HTMLElement, state: unknown, ctx: { transport: Transport }): GuiInstance
	}
}

// Server → client frames carried over the kernel WS (see frieren.ts).
type ServerFrame =
	| { type: 'state'; state: unknown }
	| { type: 'result'; id: string; result: unknown }
	| { type: 'error'; id?: string; message: string }

export function KernelAppFrame(props: { id: string; guiUrl?: string; onHome?: () => void }) {
	const { id, guiUrl, onHome } = props
	const { getToken } = useAuth()
	const getTokenRef = useRef(getToken)
	getTokenRef.current = getToken
	const containerRef = useRef<HTMLDivElement>(null)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		const container = containerRef.current
		if (!container) return
		let cancelled = false
		let socket: WebSocket | null = null
		let instance: GuiInstance | undefined
		let nextId = 0
		const pending = new Map<string, (frame: { result?: unknown; error?: string }) => void>()
		const subscribers = new Set<(state: unknown) => void>()

		const transport: Transport = {
			invoke: (action) =>
				new Promise((resolve, reject) => {
					const ws = socket
					if (!ws || ws.readyState !== ws.OPEN) {
						reject(new Error('no_connection'))
						return
					}
					const reqId = String(nextId++)
					pending.set(reqId, (frame) => {
						if (frame.error !== undefined) reject(new Error(frame.error))
						else resolve(frame.result)
					})
					ws.send(JSON.stringify({ id: reqId, action }))
				}),
			subscribe: (onState) => {
				subscribers.add(onState)
				return () => {
					subscribers.delete(onState)
				}
			}
		}

		;(async () => {
			try {
				const token = await getTokenRef.current().catch(() => null)
				if (cancelled) return
				if (!token) {
					setError('not authenticated')
					return
				}

				// Dynamic import resolves the kernel app's gui.js through the
				// per-user DO route (Volume-backed bytes). Token rides the URL
				// for the same reason the WS does — Clerk cookie auth 401s a
				// non-document fetch. Vite must not analyse this specifier.
				// The guiUrl carries `?v=<manifest.version>` when known, so
				// the asset handler can serve it with immutable cache headers.
				const base = guiUrl ?? `/api/kernel/${id}/gui.js`
				const sep = base.includes('?') ? '&' : '?'
				const mod = (await import(
					/* @vite-ignore */ `${base}${sep}token=${encodeURIComponent(token)}`
				)) as GuiModule
				if (cancelled) return

				const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
				const ws = new WebSocket(
					`${protocol}//${window.location.host}/api/kernel/${id}/ws?token=${encodeURIComponent(token)}`
				)
				socket = ws

				let mounted = false
				ws.onmessage = (event) => {
					let frame: ServerFrame
					try {
						frame = JSON.parse(event.data)
					} catch {
						return
					}
					if (frame.type === 'state') {
						if (!mounted && !cancelled) {
							mounted = true
							instance = mod.gui.mount(container, frame.state, { transport })
						} else {
							for (const fn of subscribers) fn(frame.state)
						}
						return
					}
					if (frame.type === 'result') {
						const resolver = pending.get(frame.id)
						if (resolver) {
							pending.delete(frame.id)
							resolver({ result: frame.result })
						}
						return
					}
					if (frame.type === 'error') {
						if (frame.id !== undefined) {
							const resolver = pending.get(frame.id)
							if (resolver) {
								pending.delete(frame.id)
								resolver({ error: frame.message })
							}
						} else if (!cancelled) {
							setError(frame.message)
						}
					}
				}
				ws.onerror = () => {
					if (!cancelled) setError('connection error')
				}
				ws.onclose = () => {
					for (const [, resolve] of pending) resolve({ error: 'connection_closed' })
					pending.clear()
				}
			} catch (e) {
				if (!cancelled) setError(e instanceof Error ? e.message : String(e))
			}
		})()

		return () => {
			cancelled = true
			void instance?.unmount()
			socket?.close()
			if (container) container.innerHTML = ''
		}
	}, [id, guiUrl])

	return (
		<div className="relative h-full w-full">
			<div
				ref={containerRef}
				data-app-id={id}
				className="h-full w-full overflow-hidden"
				style={{ contain: 'paint' }}
			/>
			{error ? (
				<div className="absolute inset-0 flex items-center justify-center bg-slate-950/95 p-6 text-center text-sm text-rose-200">
					Failed to load app: {error}
				</div>
			) : null}
			{onHome ? (
				<div className="absolute right-2 top-2 z-10 flex border border-sky-300 bg-slate-950/90 shadow-[3px_3px_0_rgba(0,0,0,0.45)]">
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						className="text-sky-100 hover:bg-slate-900"
						aria-label="Return home"
						title="Return home"
						onClick={onHome}
					>
						<HouseIcon />
					</Button>
				</div>
			) : null}
		</div>
	)
}
