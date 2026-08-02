import { imageType } from '@justfiles/app/image-type'
import { useEffect, useState } from 'react'
import type { Volume } from '../fs'
import { useOsRuntime } from '../os/hooks'

// The desktop wallpaper lives at a single well-known volume path, next to the
// shell's other state (/system/os-state.json, /system/agents/…). Presence means
// a custom wallpaper is set; anything that writes this path (Settings' Appearance
// pane, an app, the agent, sync from another device) updates the desktop through
// the watch below.
//
// THE SHELL ONLY READS IT. Writing is the `settings` capability's
// `appearance.writeWallpaper`, so there is one writer, one validation of what an
// image is, and one place a wallpaper can come from — Settings, on every device.
export const WALLPAPER_PATH = '/system/wallpaper'

// The wallpaper as a blob URL (bytes come straight from the local replica — no
// network, works offline), or null when unset. Bytes that are not an image this
// build can render read as unset: an empty desktop beats a broken one.
export function useWallpaper(): string | null {
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
				// A path carries no extension, and a Blob typed wrong may refuse to decode:
				// the format comes from the bytes themselves.
				const type = imageType(bytes)
				apply(type ? URL.createObjectURL(new Blob([bytes as BlobPart], { type })) : null)
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

	return url
}
