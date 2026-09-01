import {
	type PointerEvent,
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useRef,
	useState
} from 'react'
import type { WindowRect } from '../os/state'

const MIN_W = 320
const MIN_H = 200
// Approximate menubar height; the desktop sits below it, so clamp y against
// (innerHeight - TOP_INSET) to keep the titlebar grabbable.
const TOP_INSET = 32
// Dock work-area strut: bottom:20px + .frn-dock-bar height:62px + a small
// breathing gap. Windows are never *placed* under the dock (drag may transiently
// float over it, snapping back on release — mirroring the macOS Dock).
const BOTTOM_INSET = 90

type ResizeDir = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se'

const HANDLES: ResizeDir[] = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se']

// Persisted rects can point off-screen after a resize/monitor change (window
// at x=1448 on a 1440-wide viewport is invisible). Clamp so the whole frame
// sits inside the desktop area before we hand it to the renderer.
function clampToViewport(rect: WindowRect): WindowRect {
	const vw = document.documentElement.clientWidth
	const vh = document.documentElement.clientHeight
	const availH = Math.max(MIN_H, vh - TOP_INSET - BOTTOM_INSET)
	const w = Math.max(MIN_W, Math.min(rect.w, vw))
	const h = Math.max(MIN_H, Math.min(rect.h, availH))
	const x = Math.max(0, Math.min(rect.x, vw - w))
	const y = Math.max(0, Math.min(rect.y, availH - h))
	return { x, y, w, h }
}

// Controlled window chrome. The committed `rect` lives in the caller (OS store
// for app windows, local state for overlays); only drag/resize-in-progress is
// kept here and flushed via `onRectCommit` on pointer-up.
export function Window({
	title,
	rect,
	focused,
	zIndex,
	fullscreen = false,
	escapeBlocked = false,
	onClose,
	onFocus,
	onRectCommit,
	onFullscreenToggle,
	children
}: {
	title: string
	rect: WindowRect
	focused?: boolean
	zIndex?: number
	fullscreen?: boolean
	escapeBlocked?: boolean
	onClose: () => void
	onFocus?: () => void
	onRectCommit: (rect: WindowRect) => void
	onFullscreenToggle?: () => void
	children: ReactNode
}) {
	const [live, setLive] = useState<WindowRect>(() => clampToViewport(rect))
	const dragRef = useRef<{ dx: number; dy: number } | null>(null)
	const resizeRef = useRef<{ x: number; y: number; rect: WindowRect; dir: ResizeDir } | null>(null)

	// Re-sync when the committed rect changes from outside (boot restore, etc).
	// A drag commits the same value back, so this is a no-op for our own edits.
	useLayoutEffect(() => {
		setLive(clampToViewport(rect))
	}, [rect])

	// Escape exits fullscreen only — it never closes a window.
	useEffect(() => {
		if (!focused || !fullscreen || !onFullscreenToggle) return
		const handler = (event: KeyboardEvent) => {
			if (event.key === 'Escape' && !escapeBlocked) {
				event.preventDefault()
				onFullscreenToggle()
			}
		}
		window.addEventListener('keydown', handler, { capture: true })
		return () => window.removeEventListener('keydown', handler, { capture: true })
	}, [escapeBlocked, focused, fullscreen, onFullscreenToggle])

	const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
		if (fullscreen) return
		event.currentTarget.setPointerCapture(event.pointerId)
		dragRef.current = { dx: event.clientX - live.x, dy: event.clientY - live.y }
	}
	const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
		const drag = dragRef.current
		if (!drag) return
		// Clamp y >= 0 so the titlebar can't slide under the menubar and become
		// ungrabbable. Desktop coords start at the bottom of the menubar.
		setLive((r) => ({ ...r, x: event.clientX - drag.dx, y: Math.max(0, event.clientY - drag.dy) }))
	}
	const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
		dragRef.current = null
		event.currentTarget.releasePointerCapture(event.pointerId)
		onRectCommit(live)
	}

	const onResizeDown = (dir: ResizeDir) => (event: PointerEvent<HTMLDivElement>) => {
		event.stopPropagation()
		event.currentTarget.setPointerCapture(event.pointerId)
		resizeRef.current = { x: event.clientX, y: event.clientY, rect: live, dir }
	}
	const onResizeMove = (event: PointerEvent<HTMLDivElement>) => {
		const start = resizeRef.current
		if (!start) return
		const dx = event.clientX - start.x
		const dy = event.clientY - start.y
		const { dir } = start
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
		setLive({ x, y, w, h })
	}
	const onResizeUp = (event: PointerEvent<HTMLDivElement>) => {
		resizeRef.current = null
		event.currentTarget.releasePointerCapture(event.pointerId)
		onRectCommit(live)
	}

	return (
		<div
			onPointerDownCapture={onFocus}
			className={`ds-window ${fullscreen ? 'ds-window-fullscreen' : 'ds-window-floating ds-window-framed'}`}
			data-focused={focused ? 'true' : 'false'}
			style={
				fullscreen
					? { zIndex: (zIndex ?? 0) + 1000 }
					: { left: live.x, top: live.y, width: live.w, height: live.h, zIndex }
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
			<div className="ds-window-body">
				{children}
				{/* The window body is a sandboxed iframe (app GUI): a click inside it
				   focuses the frame and never reaches the parent document, so the root's
				   onPointerDownCapture focus never fires. When unfocused, cover the body
				   with a transparent catcher that activates the window on press — the
				   click is spent bringing the window forward (macOS-style click-to-focus),
				   and the iframe becomes directly interactive once focused (no catcher).
				   Applies in fullscreen too: an unfocused fullscreen window still renders
				   above the stack, so its body must remain clickable-to-focus. */}
				{onFocus && !focused ? (
					<div className="ds-window-focus-catcher" onPointerDown={onFocus} />
				) : null}
			</div>
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
