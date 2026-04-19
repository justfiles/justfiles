import { useAuth } from '@clerk/clerk-react'
import { useCallback, useEffect, useState } from 'react'
import { AuthWall } from './AuthWall'
import { ChatPage } from './ChatPage'
import { Spinner } from './components/ui/spinner'
import { FilesPage } from './FilesPage'
import { useClientLocation } from './clientRouter'
import { OnboardingPage } from './onboarding/OnboardingPage'
import { createFsVolume } from './fs'
import { resolveOnboardingState } from './onboarding/state'

function LoadingScreen({ label }: { label: string }) {
	return (
		<div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background px-6 text-center">
			<Spinner className="size-5" />
			<p className="text-sm text-muted-foreground">{label}</p>
		</div>
	)
}

function App() {
	const { isLoaded, isSignedIn, getToken } = useAuth()
	const location = useClientLocation()

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

	if (location.pathname.startsWith('/files')) {
		return <FilesPage search={location.search} />
	}

	return <ChatPage />
}

export default App
