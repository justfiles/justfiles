import { useCallback, useEffect, useState } from 'react'
import type { Volume } from '../fs'
import { useOsRuntime } from '../os/hooks'

// The desktop wallpaper lives at a single well-known volume path, next to the
// shell's other state (/system/os-state.json, /system/agents/…). Presence means
// a custom wallpaper is set; anything that writes this path (the picker below,
// an app, the agent, sync from another device) updates the desktop via watch.
export const WALLPAPER_PATH = '/system/wallpaper'

// Sniff the image MIME from magic bytes: the volume path carries no extension,
// and a Blob typed wrong may refuse to decode.
export function imageType(bytes: Uint8Array): string {
	const at = (i: number, ...sig: number[]) => sig.every((b, j) => bytes[i + j] === b)
	if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png'
	if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
	if (at(0, 0x47, 0x49, 0x46)) return 'image/gif'
	if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp'
	if (at(4, 0x66, 0x74, 0x79, 0x70)) return 'image/avif'
	if (bytes[0] === 0x3c) return 'image/svg+xml'
	return 'image/png'
}

// The wallpaper as a blob URL (bytes come straight from the local replica — no
// network, works offline), or null when unset. `set`/`clear` write the volume;
// the desktop reacts through the watch, so remote writes behave identically.
export function useWallpaper(): {
	url: string | null
	set: (file: File) => Promise<void>
	clear: () => Promise<void>
} {
	const { volume } = useOsRuntime()
	const [url, setUrl] = useState<string | null>(null)

	useEffect(() => {
		let cancelled = false
		let unwatch: (() => void) | undefined
		let current: string | null = null
		const apply = (next: string | null) => {
			if (cancelled) {
				if (next) URL.revokeObjectURL(next)
				return
			}
			if (current) URL.revokeObjectURL(current)
			current = next
			setUrl(next)
		}
		const load = async (vol: Volume) => {
			try {
				if (!(await vol.exists(WALLPAPER_PATH))) return apply(null)
				const bytes = await vol.readFile(WALLPAPER_PATH)
				apply(URL.createObjectURL(new Blob([bytes as BlobPart], { type: imageType(bytes) })))
			} catch {
				apply(null)
			}
		}
		void volume.then(async (vol) => {
			if (cancelled) return
			unwatch = await vol.watch(WALLPAPER_PATH, () => void load(vol))
			void load(vol)
		})
		return () => {
			unwatch?.()
			cancelled = true
			if (current) URL.revokeObjectURL(current)
		}
	}, [volume])

	const set = useCallback(
		async (file: File) => {
			const vol = await volume
			const bytes = new Uint8Array(await file.arrayBuffer())
			await vol.mkdir('/system', { recursive: true })
			await vol.writeFile(WALLPAPER_PATH, bytes)
		},
		[volume]
	)

	const clear = useCallback(async () => {
		const vol = await volume
		await vol.rm(WALLPAPER_PATH, { force: true })
	}, [volume])

	return { url, set, clear }
}
