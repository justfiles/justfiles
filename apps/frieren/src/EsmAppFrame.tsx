import { type AppHandle, createHost, loadApp, loadManifest } from '@justfiles/app'
import { HouseIcon } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'

export function EsmAppFrame(props: {
	id: string
	manifestUrl: string
	baseUrl: string
	onHome: () => void
}) {
	const { id, manifestUrl, baseUrl, onHome } = props
	const containerRef = useRef<HTMLDivElement>(null)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		const container = containerRef.current
		if (!container) return
		let cancelled = false
		let handle: AppHandle | undefined
		setError(null)
		;(async () => {
			try {
				const absoluteManifestUrl = new URL(manifestUrl, window.location.href).toString()
				const absoluteBaseUrl = new URL(baseUrl, window.location.href).toString()
				const manifest = await loadManifest({ url: absoluteManifestUrl })
				if (cancelled) return
				const host = createHost()
				const loaded = await loadApp({
					manifest,
					baseUrl: absoluteBaseUrl,
					el: container,
					host
				})
				if (cancelled) {
					await loaded.unmount()
					return
				}
				handle = loaded
			} catch (e) {
				if (!cancelled) setError(String(e instanceof Error ? e.message : e))
			}
		})()
		return () => {
			cancelled = true
			void handle?.unmount()
			if (container) container.innerHTML = ''
		}
	}, [manifestUrl, baseUrl])

	return (
		<div className="relative h-full w-full">
			<div ref={containerRef} data-app-id={id} className="h-full w-full overflow-hidden" />
			{error ? (
				<div className="absolute inset-0 flex items-center justify-center bg-slate-950/95 p-6 text-center text-sm text-rose-200">
					Failed to load app: {error}
				</div>
			) : null}
			<div className="absolute right-2 top-2 z-10 flex border border-sky-300 bg-slate-950/90 shadow-[3px_3px_0_rgba(0,0,0,0.45)]">
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					className="text-sky-100 hover:bg-slate-900"
					aria-label="Return home"
					title="Return home"
					onClick={onHome}
				>
					<HouseIcon />
				</Button>
			</div>
		</div>
	)
}
