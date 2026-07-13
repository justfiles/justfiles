import { registerSW } from 'virtual:pwa-register'
import { useCallback, useEffect, useRef, useState } from 'react'

// The browser only checks for a new service worker on navigation or every ~24h,
// so an installed PWA left open never notices a deploy. Poll hourly, and also
// when the tab regains focus, so the "Update available" toast can actually fire.
const UPDATE_INTERVAL_MS = 60 * 60 * 1000

export function usePWA() {
	const [needRefresh, setNeedRefresh] = useState(false)
	const [offlineReady, setOfflineReady] = useState(false)
	const updateRef = useRef<((reload?: boolean) => Promise<void>) | undefined>(undefined)

	useEffect(() => {
		let interval: ReturnType<typeof setInterval> | undefined
		updateRef.current = registerSW({
			immediate: true,
			onNeedRefresh: () => setNeedRefresh(true),
			onOfflineReady: () => setOfflineReady(true),
			onRegisteredSW: (swUrl, r) => {
				if (!r) return
				const check = async () => {
					if (r.installing || !navigator.onLine) return
					// Confirm the SW script is still reachable before asking the browser
					// to update, so a flaky network doesn't discard the registration.
					const resp = await fetch(swUrl, { cache: 'no-store' }).catch(() => undefined)
					if (resp?.status === 200) await r.update()
				}
				interval = setInterval(() => void check(), UPDATE_INTERVAL_MS)
				document.addEventListener('visibilitychange', () => {
					if (document.visibilityState === 'visible') void check()
				})
			}
		})
		return () => clearInterval(interval)
	}, [])

	const updateSW = useCallback(
		(reload?: boolean) => updateRef.current?.(reload) ?? Promise.resolve(),
		[]
	)
	const close = useCallback(() => {
		setNeedRefresh(false)
		setOfflineReady(false)
	}, [])

	return { needRefresh, offlineReady, updateSW, close }
}
