import { useAuth } from '@clerk/clerk-react'
import type { AppRelay } from '@justfiles/app'
import { HouseIcon } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { type EsmAppSession, runEsmApp } from './esmAppRunner'

// Thin React shell. The session lifecycle (load manifest, build host,
// register tools, register describe, dispatch tool invocations, dispose)
// lives in `runEsmApp` as plain JS — that way chat-input re-renders or
// any other React churn can never restart the app session.
export function EsmAppFrame(props: {
	id: string
	manifestUrl: string
	baseUrl: string
	relay: AppRelay
	setAppDescribe: (fn: (() => Promise<string | null>) | null) => void
	onHome: () => void
}) {
	const { id, manifestUrl, baseUrl, relay, setAppDescribe, onHome } = props
	const { getToken } = useAuth()
	const getTokenRef = useRef(getToken)
	getTokenRef.current = getToken
	const relayRef = useRef(relay)
	relayRef.current = relay
	const setAppDescribeRef = useRef(setAppDescribe)
	setAppDescribeRef.current = setAppDescribe
	const containerRef = useRef<HTMLDivElement>(null)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		const container = containerRef.current
		if (!container) return
		let session: EsmAppSession | undefined
		let cancelled = false
		const abort = new AbortController()
		setError(null)

		runEsmApp({
			el: container,
			manifestUrl,
			baseUrl,
			getToken: () => getTokenRef.current(),
			relay: relayRef.current,
			setAppDescribe: setAppDescribeRef.current,
			signal: abort.signal
		})
			.then((s) => {
				if (cancelled) {
					void s.dispose()
					return
				}
				session = s
			})
			.catch((e) => {
				if (!cancelled) setError(String(e instanceof Error ? e.message : e))
			})

		return () => {
			cancelled = true
			abort.abort()
			void session?.dispose()
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
