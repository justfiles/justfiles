import { useCallback, useEffect, useMemo, useState } from 'react'

// Presentation mode: frames become slides, the viewport is pinned to one slide
// at a time, and the pointer is a laser.
//
// Why NOT `viewModeEnabled` (the obvious choice): in Excalidraw 0.18 view mode
// is the *most* pannable mode — `handleCanvasPanUsingWheelOrSpaceDrag` returns
// true for any left-drag while it is on, and it runs before the tool dispatch,
// so the laser can never start a path. Instead we stay in edit mode and:
//
//   - keep the laser tool active, which owns the primary-pointer drag (panning
//     needs the wheel button, space, or the hand tool) and creates no elements
//     (double-click is also inert for non-selection tools),
//   - swallow every other viewport input in the capture phase (see the clamp
//     below),
//   - hide Excalidraw's own UI from CSS (see gui.css).
//
// Upstream `master` has real APIs for this (`interaction.tools.laser`,
// `appState.scrollConstraints`, `api.setViewport`) — unreleased as of 0.18.1.
// When they ship, the clamp and the CSS both go away.

// The slice of Excalidraw's imperative API a presentation drives.
export interface PresentAPI {
	getSceneElements: () => readonly unknown[]
	getAppState: () => Record<string, unknown>
	updateScene: (scene: { appState?: Record<string, unknown> }) => void
	scrollToContent: (
		target: unknown,
		opts: {
			fitToViewport?: boolean
			viewportZoomFactor?: number
			animate?: boolean
			duration?: number
		}
	) => void
	updateFrameRendering: (opts: { name?: boolean; outline?: boolean }) => void
	setActiveTool: (tool: { type: string }) => void
	refresh: () => void
}

type Frame = { id: string; x: number; y: number; width: number; height: number }
type Element = Partial<Frame> & { type?: string; isDeleted?: boolean }

// Slides in reading order: frames grouped into rows (a frame joins the current
// row while its top is within half a slide-height of the row's top), each row
// left to right. Scene order is z-order, so it can't be the deck order —
// bringing one frame to front would silently reshuffle the slides.
export function orderFrames(elements: readonly unknown[]): Frame[] {
	const frames = (elements as readonly Element[]).filter(
		(el): el is Frame => el.type === 'frame' && !el.isDeleted
	)
	const heights = frames.map((f) => f.height).sort((a, b) => a - b)
	const tolerance = (heights[heights.length >> 1] ?? 0) / 2
	const rows: Frame[][] = []
	let rowTop = 0
	for (const frame of [...frames].sort((a, b) => a.y - b.y)) {
		const row = rows[rows.length - 1]
		if (row && frame.y - rowTop <= tolerance) {
			row.push(frame)
		} else {
			rows.push([frame])
			rowTop = frame.y
		}
	}
	return rows.flatMap((row) => row.sort((a, b) => a.x - b.x))
}

const NEXT = new Set(['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n'])
const PREV = new Set(['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p'])

export function Presenter({
	api,
	host,
	onExit
}: {
	api: PresentAPI
	host: HTMLElement | null
	onExit: () => void
}) {
	// The deck is a snapshot: the scene can't change while presenting.
	const slides = useMemo(() => orderFrames(api.getSceneElements()), [api])
	const [index, setIndex] = useState(0)
	const last = slides.length - 1
	const slide = slides[index]

	const step = useCallback(
		(delta: number) => setIndex((i) => Math.min(last, Math.max(0, i + delta))),
		[last]
	)

	// Pin the viewport to the current slide. refresh() first: entering hides the
	// file bar, so Excalidraw's cached container offsets are a frame stale.
	const fit = useCallback(
		(animate: boolean) => {
			if (!slide) return
			api.refresh()
			api.scrollToContent(slide, {
				fitToViewport: true,
				viewportZoomFactor: 0.92,
				animate,
				duration: 200
			})
		},
		[api, slide]
	)

	useEffect(() => {
		const raf = requestAnimationFrame(() => fit(true))
		return () => cancelAnimationFrame(raf)
	}, [fit])

	// Re-fit when the canvas box changes (window resize, host detach/attach).
	useEffect(() => {
		if (!host) return
		let raf = 0
		const ro = new ResizeObserver(() => {
			cancelAnimationFrame(raf)
			raf = requestAnimationFrame(() => fit(false))
		})
		ro.observe(host)
		return () => {
			cancelAnimationFrame(raf)
			ro.disconnect()
		}
	}, [host, fit])

	// Presentation dressing, undone on exit: laser pointer, no frame outlines or
	// names, and the pre-presentation viewport and tool restored. `image` would
	// re-open the file picker and `custom` needs its customType, so those two fall
	// back to the selection tool. `activeTool.locked` needs no handling: Excalidraw
	// merges `locked: data.locked ?? state.activeTool.locked`, so the flag rides
	// through the laser and back untouched.
	useEffect(() => {
		const { scrollX, scrollY, zoom, activeTool } = api.getAppState()
		const was = (activeTool as { type?: string } | undefined)?.type
		const restored = !was || was === 'image' || was === 'custom' ? 'selection' : was
		api.updateFrameRendering({ name: false, outline: false })
		api.setActiveTool({ type: 'laser' })
		return () => {
			api.updateFrameRendering({ name: true, outline: true })
			api.setActiveTool({ type: restored })
			api.updateScene({ appState: { scrollX, scrollY, zoom } })
		}
	}, [api])

	// The input clamp. Every input that could move the viewport or edit the scene is
	// bound by Excalidraw on its container (wheel) or on document (keys, gestures,
	// touch, clipboard, drop), all in the bubble phase — so one capture-phase
	// listener on window runs first and stopPropagation() keeps the editor from ever
	// seeing it.
	useEffect(() => {
		const swallow = (e: Event) => {
			e.stopPropagation()
			if (e.cancelable) e.preventDefault()
		}
		const onTouchMove = (e: TouchEvent) => {
			if (e.touches.length > 1) swallow(e) // pinch; one finger drives the laser
		}
		const onPointerDown = (e: PointerEvent) => {
			if (e.button !== 0) swallow(e) // wheel-button drag pans
		}
		const onKeyDown = (e: KeyboardEvent) => {
			// A presentation owns the keyboard. The editor sees nothing (plain keys switch
			// tools; cmd+Z/V/D/… would edit the scene behind the deck's snapshot, which
			// autosave would then persist) and the browser's own combos are held off too
			// (zoom rescales the slide, select-all paints the overlay, print/save/reload
			// are all mis-fires mid-deck). Esc leaves; then everything works again.
			e.stopPropagation()
			e.preventDefault()
			const plain = !e.ctrlKey && !e.metaKey && !e.altKey
			if (e.key === 'Escape') onExit()
			else if (plain && NEXT.has(e.key)) step(1)
			else if (plain && PREV.has(e.key)) step(-1)
		}
		const opts = { capture: true, passive: false } as const
		// wheel & gestures pan/zoom; contextmenu, paste, cut & drop edit the scene.
		const swallowed = [
			'wheel',
			'gesturestart',
			'gesturechange',
			'contextmenu',
			'paste',
			'cut',
			'drop'
		]
		for (const type of swallowed) window.addEventListener(type, swallow, opts)
		window.addEventListener('touchmove', onTouchMove, opts)
		window.addEventListener('pointerdown', onPointerDown, opts)
		window.addEventListener('keydown', onKeyDown, opts)
		return () => {
			for (const type of swallowed) window.removeEventListener(type, swallow, opts)
			window.removeEventListener('touchmove', onTouchMove, opts)
			window.removeEventListener('pointerdown', onPointerDown, opts)
			window.removeEventListener('keydown', onKeyDown, opts)
		}
	}, [step, onExit])

	return (
		<div className="draw-present-bar">
			<button type="button" onClick={() => step(-1)} disabled={index === 0} title="Previous slide">
				‹
			</button>
			<span className="draw-present-count">
				{index + 1} / {slides.length}
			</span>
			<button type="button" onClick={() => step(1)} disabled={index === last} title="Next slide">
				›
			</button>
			<button type="button" onClick={onExit} title="Exit presentation (Esc)">
				Exit
			</button>
		</div>
	)
}
