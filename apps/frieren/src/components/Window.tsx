import { type PointerEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import type { WindowRect } from '../windowState'

const MIN_W = 320
const MIN_H = 200

type ResizeDir = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se'

const HANDLES: ResizeDir[] = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se']

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
	fullscreen = false,
	onFullscreenToggle,
	children
}: {
	title: string
	onClose: () => void
	onFocus?: () => void
	focused?: boolean
	zIndex?: number
	initialOffset?: number
	persist?: WindowPersist
	fullscreen?: boolean
	onFullscreenToggle?: () => void
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
	const resizeRef = useRef<{
		x: number
		y: number
		rect: WindowRect
		dir: ResizeDir
	} | null>(null)
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
				if (fullscreen && onFullscreenToggle) onFullscreenToggle()
				else onClose()
			}
		}
		window.addEventListener('keydown', handler, { capture: true })
		return () => window.removeEventListener('keydown', handler, { capture: true })
	}, [focused, onClose, fullscreen, onFullscreenToggle])

	const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
		if (!rect || fullscreen) return
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

	const onResizeDown = (dir: ResizeDir) => (event: PointerEvent<HTMLDivElement>) => {
		if (!rect) return
		event.stopPropagation()
		event.currentTarget.setPointerCapture(event.pointerId)
		resizeRef.current = { x: event.clientX, y: event.clientY, rect, dir }
	}
	const onResizeMove = (event: PointerEvent<HTMLDivElement>) => {
		const start = resizeRef.current
		if (!start) return
		const dx = event.clientX - start.x
		const dy = event.clientY - start.y
		const { dir } = start
		setRect(() => {
			let { x, y, w, h } = start.rect
			if (dir.includes('e')) w = Math.max(MIN_W, start.rect.w + dx)
			if (dir.includes('s')) h = Math.max(MIN_H, start.rect.h + dy)
			if (dir.includes('w')) {
				w = Math.max(MIN_W, start.rect.w - dx)
				x = start.rect.x + start.rect.w - w
			}
			if (dir.includes('n')) {
				h = Math.max(MIN_H, start.rect.h - dy)
				y = start.rect.y + start.rect.h - h
			}
			return { x, y, w, h }
		})
	}
	const onResizeUp = (event: PointerEvent<HTMLDivElement>) => {
		resizeRef.current = null
		event.currentTarget.releasePointerCapture(event.pointerId)
	}

	if (!rect) return null

	return (
		<div
			onPointerDownCapture={onFocus}
			className={`ds-window ${fullscreen ? 'ds-window-fullscreen' : 'ds-window-floating'}`}
			data-focused={focused ? 'true' : 'false'}
			style={
				fullscreen
					? { zIndex: (zIndex ?? 0) + 1000 }
					: { left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex }
			}
		>
			<div
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				className="ds-window-titlebar"
			>
				<div className="ds-window-controls">
					<button
						type="button"
						aria-label="Close"
						onPointerDown={(event) => event.stopPropagation()}
						onClick={onClose}
						className="ds-window-control ds-window-control-close"
					/>
					{onFullscreenToggle ? (
						<button
							type="button"
							aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
							onPointerDown={(event) => event.stopPropagation()}
							onClick={onFullscreenToggle}
							className="ds-window-control ds-window-control-fullscreen"
						/>
					) : null}
				</div>
				<span className="ds-window-title">{title}</span>
				<span className="ds-window-spacer" />
			</div>
			<div className="ds-window-body">{children}</div>
			{fullscreen
				? null
				: HANDLES.map((dir) => (
						<div
							key={dir}
							onPointerDown={onResizeDown(dir)}
							onPointerMove={onResizeMove}
							onPointerUp={onResizeUp}
							className={`ds-window-resize ds-window-resize-${dir}`}
						/>
					))}
		</div>
	)
}
