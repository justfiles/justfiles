import { type PointerEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import type { WindowRect } from '../windowState'

const MIN_W = 320
const MIN_H = 200

export interface WindowPersist {
	load(): Promise<WindowRect | null>
	save(rect: WindowRect): void
}

export function Window({
	title,
	onClose,
	onFocus,
	focused,
	zIndex,
	initialOffset = 0,
	persist,
	children
}: {
	title: string
	onClose: () => void
	onFocus?: () => void
	focused?: boolean
	zIndex?: number
	initialOffset?: number
	persist?: WindowPersist
	children: ReactNode
}) {
	const initialOffsetRef = useRef(initialOffset)
	const defaultRect = useCallback(
		(): WindowRect => ({
			x: 80 + initialOffsetRef.current,
			y: 40 + initialOffsetRef.current,
			w: 720,
			h: 520
		}),
		[]
	)

	const [rect, setRect] = useState<WindowRect | null>(() => (persist ? null : defaultRect()))
	const dragRef = useRef<{ dx: number; dy: number } | null>(null)
	const resizeRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null)
	const saveTimerRef = useRef<number | null>(null)
	const savedRectRef = useRef<WindowRect | null>(null)

	useEffect(() => {
		if (!persist) return
		let cancelled = false
		void persist.load().then((loaded) => {
			if (cancelled) return
			savedRectRef.current = loaded
			setRect(loaded ?? defaultRect())
		})
		return () => {
			cancelled = true
		}
	}, [persist, defaultRect])

	useEffect(() => {
		if (!persist || !rect) return
		const saved = savedRectRef.current
		if (
			saved &&
			saved.x === rect.x &&
			saved.y === rect.y &&
			saved.w === rect.w &&
			saved.h === rect.h
		) {
			return
		}
		if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
		saveTimerRef.current = window.setTimeout(() => {
			persist.save(rect)
			savedRectRef.current = rect
		}, 300)
		return () => {
			if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
		}
	}, [rect, persist])

	useEffect(() => {
		if (!focused) return
		const handler = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.preventDefault()
				onClose()
			}
		}
		window.addEventListener('keydown', handler, { capture: true })
		return () => window.removeEventListener('keydown', handler, { capture: true })
	}, [focused, onClose])

	const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
		if (!rect) return
		event.currentTarget.setPointerCapture(event.pointerId)
		dragRef.current = { dx: event.clientX - rect.x, dy: event.clientY - rect.y }
	}
	const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
		const drag = dragRef.current
		if (!drag) return
		setRect((r) => (r ? { ...r, x: event.clientX - drag.dx, y: event.clientY - drag.dy } : r))
	}
	const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
		dragRef.current = null
		event.currentTarget.releasePointerCapture(event.pointerId)
	}

	const onResizeDown = (event: PointerEvent<HTMLDivElement>) => {
		if (!rect) return
		event.stopPropagation()
		event.currentTarget.setPointerCapture(event.pointerId)
		resizeRef.current = { x: event.clientX, y: event.clientY, w: rect.w, h: rect.h }
	}
	const onResizeMove = (event: PointerEvent<HTMLDivElement>) => {
		const start = resizeRef.current
		if (!start) return
		const dx = event.clientX - start.x
		const dy = event.clientY - start.y
		setRect((r) =>
			r
				? {
						...r,
						w: Math.max(MIN_W, start.w + dx),
						h: Math.max(MIN_H, start.h + dy)
					}
				: r
		)
	}
	const onResizeUp = (event: PointerEvent<HTMLDivElement>) => {
		resizeRef.current = null
		event.currentTarget.releasePointerCapture(event.pointerId)
	}

	if (!rect) return null

	return (
		<div
			onPointerDownCapture={onFocus}
			className="absolute flex flex-col overflow-hidden rounded-md shadow-[0_20px_50px_rgba(0,0,0,0.35)]"
			style={{
				left: rect.x,
				top: rect.y,
				width: rect.w,
				height: rect.h,
				zIndex,
				background: '#ffffff',
				border: '1px solid var(--rule)',
				color: 'var(--text)',
				fontFamily: 'var(--font-ui)',
				fontSize: 'var(--text-ui)'
			}}
		>
			<div
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				className="flex h-7 flex-none cursor-default select-none items-center gap-2 px-2"
				style={{ background: 'var(--surface)', borderBottom: '1px solid var(--rule)' }}
			>
				<button
					type="button"
					aria-label="Close"
					onPointerDown={(event) => event.stopPropagation()}
					onClick={onClose}
					className="size-3 rounded-full"
					style={{ background: '#ff5f57', border: '1px solid rgba(0,0,0,0.18)' }}
				/>
				<span className="flex-1 text-center" style={{ opacity: focused ? 1 : 0.55 }}>
					{title}
				</span>
				<span className="w-3" />
			</div>
			<div className="flex-1 overflow-hidden">{children}</div>
			<div
				onPointerDown={onResizeDown}
				onPointerMove={onResizeMove}
				onPointerUp={onResizeUp}
				title="Resize"
				className="absolute right-0 bottom-0 size-4 cursor-nwse-resize"
				style={{
					background:
						'linear-gradient(135deg, transparent 0 55%, var(--rule) 55% 65%, transparent 65% 75%, var(--rule) 75% 85%, transparent 85%)'
				}}
			/>
		</div>
	)
}
