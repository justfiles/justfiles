import type { Volume } from './fs'

export interface WindowRect {
	x: number
	y: number
	w: number
	h: number
}

function path(appId: string): string {
	return `/applications/${appId}/window.json`
}

export async function loadWindowRect(volume: Volume, appId: string): Promise<WindowRect | null> {
	const file = path(appId)
	if (!(await volume.exists(file))) return null
	try {
		const bytes = await volume.readFile(file)
		const data = JSON.parse(new TextDecoder().decode(bytes))
		if (
			typeof data?.x === 'number' &&
			typeof data?.y === 'number' &&
			typeof data?.w === 'number' &&
			typeof data?.h === 'number'
		) {
			return data
		}
		return null
	} catch {
		return null
	}
}

export async function saveWindowRect(
	volume: Volume,
	appId: string,
	rect: WindowRect
): Promise<void> {
	await volume.mkdir(`/applications/${appId}`, { recursive: true })
	await volume.writeFile(path(appId), new TextEncoder().encode(JSON.stringify(rect)))
}
