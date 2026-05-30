import { useAuth } from '@clerk/clerk-react'
import { useCallback, useEffect, useState } from 'react'
import { AuthWall } from './AuthWall'
import { AgentProvider } from './agent/Provider'
import { Spinner } from './components/ui/spinner'
import { getFsVolume, releaseFsVolume } from './fs'
import { OnboardingPage } from './onboarding/OnboardingPage'
import { resolveOnboardingState } from './onboarding/state'
import { OSProvider } from './os/Provider'
import { DesktopShell } from './shell/DesktopShell'

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
	const { isLoaded, isSignedIn, userId, getToken } = useAuth()

	const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null)
	const [chooserForUserId, setChooserForUserId] = useState<string | null>(null)
	const showChooser = chooserForUserId !== null && chooserForUserId === userId

	useEffect(() => {
		if (!isSignedIn || !userId) {
			setOnboardingDone(null)
			void releaseFsVolume({ flush: false })
			return
		}
		setOnboardingDone(null)
		let cancelled = false
		void (async () => {
			try {
				const vol = await getFsVolume(userId, () => getToken())
				// localFirst returns before the first sync settles; wait for it so a
				// returning user's onboarding state reflects the backend, not an empty
				// local replica. Resolves even offline (flush swallows sync errors).
				await vol.flush()
				const state = await resolveOnboardingState(vol)
				if (!cancelled) setOnboardingDone(state === 'done')
			} catch {
				if (!cancelled) setOnboardingDone(false)
			}
		})()
		return () => {
			cancelled = true
		}
	}, [isSignedIn, userId, getToken])

	const handleOnboardingComplete = useCallback(() => setOnboardingDone(true), [])
	const requestSwitchUser = useCallback(() => {
		if (userId) setChooserForUserId(userId)
	}, [userId])
	const dismissChooser = useCallback(() => setChooserForUserId(null), [])

	if (!isLoaded) return <LoadingScreen label="Loading session…" />
	if (!isSignedIn) return <AuthWall />
	if (showChooser) return <AuthWall onDismiss={dismissChooser} />
	if (onboardingDone === null) return <LoadingScreen label="Loading workspace…" />
	if (!onboardingDone) return <OnboardingPage onComplete={handleOnboardingComplete} />

	return (
		<OSProvider>
			<AgentProvider>
				<DesktopShell onSwitchUser={requestSwitchUser} />
			</AgentProvider>
		</OSProvider>
	)
}

export default App
