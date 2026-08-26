export type Mode = 'sheet' | 'sidebar'

const MIN_APP_WIDTH = 320
const MIN_APP_HEIGHT = 120
const MIN_SIDEBAR_SIZE = 240
const MIN_SHEET_SIZE = 160
const SEAM_SIZE = 1

export function effectiveMode(mode: Mode, width: number, sidebarSize: number): Mode {
	if (
		mode === 'sidebar' &&
		width < MIN_APP_WIDTH + Math.max(MIN_SIDEBAR_SIZE, sidebarSize) + SEAM_SIZE
	)
		return 'sheet'
	return mode
}

export function clampPanelSize(mode: Mode, size: number, extent: number): number {
	const min = mode === 'sheet' ? MIN_SHEET_SIZE : MIN_SIDEBAR_SIZE
	const room = mode === 'sheet' ? MIN_APP_HEIGHT : MIN_APP_WIDTH
	const max = Number.isFinite(extent) ? Math.max(min, extent - room - SEAM_SIZE) : size
	return Math.min(max, Math.max(min, size))
}
