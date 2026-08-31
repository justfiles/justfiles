import { usePWA } from './pwa'

export function PWAToast() {
	const { needRefresh, updateSW } = usePWA()
	if (!needRefresh) return null
	return (
		<div className="frn-toast" role="status">
			<span>A new version is available.</span>
			<button type="button" data-primary onClick={() => void updateSW(true)}>
				Reload
			</button>
		</div>
	)
}
