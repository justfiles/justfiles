import { useEffect, useState } from 'react'
import { registerSW } from 'virtual:pwa-register'

export function usePWA() {
	const [needRefresh, setNeedRefresh] = useState(false)
	const [offlineReady, setOfflineReady] = useState(false)
	const [updateSW, setUpdateSW] = useState<((reload?: boolean) => Promise<void>) | undefined>()

	useEffect(() => {
		const update = registerSW({
			immediate: true,
			onNeedRefresh: () => setNeedRefresh(true),
			onOfflineReady: () => setOfflineReady(true),
		})
		setUpdateSW(() => update)
	}, [])

	function close() {
		setNeedRefresh(false)
		setOfflineReady(false)
	}

	return { needRefresh, offlineReady, updateSW, close }
}
