import { usePWA } from './usePWA'

export function PWAToast() {
	const { needRefresh, offlineReady, updateSW, close } = usePWA()

	if (!needRefresh && !offlineReady) return null

	return (
		<div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-lg bg-base-300 px-4 py-3 shadow-lg text-sm">
			{offlineReady ? (
				<span>App ready for offline use.</span>
			) : (
				<span>Update available.</span>
			)}
			{needRefresh && (
				<button
					type="button"
					className="btn btn-sm btn-primary"
					onClick={() => updateSW?.(true)}
				>
					Reload
				</button>
			)}
			<button type="button" className="btn btn-sm btn-ghost" onClick={close}>
				Dismiss
			</button>
		</div>
	)
}
