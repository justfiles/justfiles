import { useAuth } from '@clerk/clerk-react'
import { useCallback, useEffect, useState } from 'react'
import { AuthWall } from './AuthWall'
import { ChatPage } from './ChatPage'
import { FilesPage } from './FilesPage'
import { useClientLocation } from './clientRouter'
import { OnboardingPage } from './onboarding/OnboardingPage'
import { createFsVolume } from './fs'
import { resolveOnboardingState } from './onboarding/state'

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

	if (!isLoaded) return <p className="m-8">Loading…</p>
	if (!isSignedIn) return <AuthWall />
	if (onboardingDone === null) return <p className="m-8">Loading…</p>
	if (!onboardingDone) return <OnboardingPage onComplete={handleOnboardingComplete} />

	if (location.pathname.startsWith('/files')) {
		return <FilesPage search={location.search} />
	}

	return <ChatPage />
}

export default App
