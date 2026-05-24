import { useAuth } from '@clerk/clerk-react'
import { useCallback, useEffect, useState } from 'react'
import { AuthWall } from './AuthWall'
import { ChatPage } from './ChatPage'
import { Spinner } from './components/ui/spinner'
import { createFsVolume } from './fs'
import { OnboardingPage } from './onboarding/OnboardingPage'
import { resolveOnboardingState } from './onboarding/state'

function LoadingScreen({ label }: { label: string }) {
	return (
		<div
			className="flex min-h-dvh flex-col items-center justify-center gap-3 px-6 text-center text-white"
			style={{
				background:
					'radial-gradient(ellipse at 50% 30%, rgba(255,255,255,0.12), transparent 60%), var(--desktop-bg)'
			}}
		>
			<Spinner className="size-5 text-white/80" />
			<p className="text-xs tracking-wide text-white/65">{label}</p>
		</div>
	)
}

function App() {
	const { isLoaded, isSignedIn, getToken } = useAuth()

	const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null)

	useEffect(() => {
		if (!isSignedIn) return
		let cancelled = false
		void (async () => {
			try {
				const vol = await createFsVolume(() => getToken())
				const state = await resolveOnboardingState(vol)
				if (!cancelled) setOnboardingDone(state === 'done')
			} catch {
				if (!cancelled) setOnboardingDone(false)
			}
		})()
		return () => {
			cancelled = true
		}
	}, [isSignedIn, getToken])

	const handleOnboardingComplete = useCallback(() => setOnboardingDone(true), [])

	if (!isLoaded) return <LoadingScreen label="Loading session…" />
	if (!isSignedIn) return <AuthWall />
	if (onboardingDone === null) return <LoadingScreen label="Loading workspace…" />
	if (!onboardingDone) return <OnboardingPage onComplete={handleOnboardingComplete} />

	return <ChatPage />
}

export default App
