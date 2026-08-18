import type { IconCamera } from './icon-document.ts'

export const ICON_WINDOW_RATIO = 0.82
export const ICON_FIT_FILL_RATIO = 0.86

export const iconFitViewportFactor = (windowFactor: number) => windowFactor * ICON_FIT_FILL_RATIO

export type IconWindowLayout = {
	left: number
	top: number
	size: number
}

type ResizeInput = {
	width: number
	height: number
	hostLeft: number
	hostTop: number
	offsetLeft: number
	offsetTop: number
	scrollX: number
	scrollY: number
	zoom: number
}

export function iconWindowLayout(width: number, height: number): IconWindowLayout {
	const size = Math.max(64, Math.floor(Math.min(width, height) * ICON_WINDOW_RATIO))
	return {
		left: (width - size) / 2,
		top: (height - size) / 2,
		size
	}
}

export function resizeIconViewport(input: ResizeInput): {
	layout: IconWindowLayout
	camera: IconCamera
	zoom: number
} {
	const layout = iconWindowLayout(input.width, input.height)
	return {
		layout,
		camera: {
			x: (input.hostLeft + layout.left - input.offsetLeft) / input.zoom - input.scrollX,
			y: (input.hostTop + layout.top - input.offsetTop) / input.zoom - input.scrollY,
			size: layout.size / input.zoom
		},
		// Browser resizing changes the visible crop, not the user-controlled
		// Excalidraw zoom level.
		zoom: input.zoom
	}
}
