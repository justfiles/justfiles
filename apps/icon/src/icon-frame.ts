import { convertToExcalidrawElements } from '@excalidraw/excalidraw'
import type { ExcalidrawFrameLikeElement } from '@excalidraw/excalidraw/element/types'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { ICON_BOUNDS, type IconCamera } from './icon-document.ts'

const [frame] = convertToExcalidrawElements(
	[
		{
			type: 'frame',
			id: 'icon-output-frame',
			name: 'Icon output',
			...ICON_BOUNDS,
			children: []
		}
	],
	{ regenerateIds: false }
)

if (frame?.type !== 'frame') throw new Error('Could not create the icon output frame')

// This frame is deliberately never inserted into the scene. Copies of it are
// positioned behind the fixed viewport window for the viewport and export APIs.
const ICON_FRAME_TEMPLATE: ExcalidrawFrameLikeElement = frame

export function iconFrame(camera: IconCamera): ExcalidrawFrameLikeElement {
	return {
		...ICON_FRAME_TEMPLATE,
		x: camera.x,
		y: camera.y,
		width: camera.size,
		height: camera.size
	}
}

export function focusIconCamera(
	api: ExcalidrawImperativeAPI,
	camera: IconCamera,
	viewportZoomFactor: number,
	animate = false
) {
	api.refresh()
	api.scrollToContent(iconFrame(camera), {
		fitToViewport: true,
		viewportZoomFactor,
		animate,
		duration: animate ? 220 : 0
	})
}

export function fitIcon(api: ExcalidrawImperativeAPI, viewportZoomFactor: number, animate = true) {
	const elements = api.getSceneElements()
	if (elements.length === 0) return
	api.refresh()
	api.scrollToContent(elements, {
		fitToViewport: true,
		viewportZoomFactor,
		animate,
		duration: animate ? 220 : 0
	})
}
