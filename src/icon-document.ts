export const ICON_SIZE = 1024
export const ICON_MIN = -ICON_SIZE / 2

export type IconCamera = {
	x: number
	y: number
	size: number
}

export const DEFAULT_ICON_CAMERA: IconCamera = {
	x: ICON_MIN,
	y: ICON_MIN,
	size: ICON_SIZE
}

export const ICON_BOUNDS = {
	x: DEFAULT_ICON_CAMERA.x,
	y: DEFAULT_ICON_CAMERA.y,
	width: ICON_SIZE,
	height: ICON_SIZE
} as const

export type IconSettings = {
	exportBackground: boolean
	// Apple's app icon keyline grid, drawn over the output window as an editor
	// guide. It is host UI, so it never reaches the scene or the export.
	grid: boolean
	camera: IconCamera
}

export const DEFAULT_ICON_SETTINGS: IconSettings = {
	exportBackground: false,
	grid: true,
	camera: DEFAULT_ICON_CAMERA
}

export const iconExportScale = (camera: IconCamera) => ICON_SIZE / camera.size

function finite(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value)
}

function flag(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback
}

function cameraOf(value: unknown): IconCamera {
	if (!value || typeof value !== 'object') return DEFAULT_ICON_CAMERA
	const { x, y, size } = value as Partial<IconCamera>
	return finite(x) && finite(y) && finite(size) && size > 0 ? { x, y, size } : DEFAULT_ICON_CAMERA
}

export function iconSettingsOf(value: unknown): IconSettings {
	if (!value || typeof value !== 'object') return DEFAULT_ICON_SETTINGS
	const icon = (value as { icon?: unknown }).icon
	if (typeof icon !== 'object' || icon === null) return DEFAULT_ICON_SETTINGS
	const { exportBackground, grid, camera } = icon as Partial<Record<keyof IconSettings, unknown>>
	return {
		exportBackground: flag(exportBackground, DEFAULT_ICON_SETTINGS.exportBackground),
		grid: flag(grid, DEFAULT_ICON_SETTINGS.grid),
		camera: cameraOf(camera)
	}
}

// Excalidraw ignores unknown root fields, so this remains a valid .excalidraw
// file while preserving icon-specific settings across app sessions.
export function withIconSettings(sceneJson: string, settings: IconSettings): string {
	const document = JSON.parse(sceneJson) as Record<string, unknown>
	document.icon = settings
	return JSON.stringify(document, null, 2)
}
