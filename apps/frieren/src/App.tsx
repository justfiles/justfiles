import { useAuth } from '@clerk/clerk-react'
import { useCallback, useEffect, useState } from 'react'
import { AuthWall } from './AuthWall'
import { AgentProvider } from './agent/Provider'
import { Spinner } from './components/ui/spinner'
import { activeProfileId, attachRemoteUser, openProfile, pauseActiveVolume } from './fs'
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

	const [profileId, setProfileId] = useState<string | null>(null)
	const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null)
	const [chooserForUserId, setChooserForUserId] = useState<string | null>(null)
	const showChooser = chooserForUserId !== null && chooserForUserId === userId

	// Boot a local profile immediately — independent of Clerk. The desktop never
	// waits for clerk-js to load or for a sign-in; it opens local IDB and renders.
	useEffect(() => {
		void openProfile().catch(() => {})
		setProfileId(activeProfileId())
	}, [])

	// Auth only upgrades the running OS; it never gates boot. When a signed-in
	// session resolves, attach sync (switching profiles if the user owns a
	// different one) and resolve their onboarding state. Signing out just pauses
	// sync — the local profile stays open.
	useEffect(() => {
		if (!isLoaded) return
		if (!isSignedIn || !userId) {
			setOnboardingDone(null)
			pauseActiveVolume()
			return
		}
		let cancelled = false
		void (async () => {
			try {
				const vol = await attachRemoteUser(userId, () => getToken())
				if (cancelled) return
				setProfileId(activeProfileId())
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
	}, [isLoaded, isSignedIn, userId, getToken])

	const handleOnboardingComplete = useCallback(() => setOnboardingDone(true), [])
	const requestSwitchUser = useCallback(() => {
		if (userId) setChooserForUserId(userId)
	}, [userId])
	const dismissChooser = useCallback(() => setChooserForUserId(null), [])

	if (!profileId) return <LoadingScreen label="Starting…" />
	if (showChooser) return <AuthWall onDismiss={dismissChooser} />
	// Signed-in users finish setup once auth resolves; anonymous users go straight in.
	if (isLoaded && isSignedIn && onboardingDone === null)
		return <LoadingScreen label="Loading workspace…" />
	if (isSignedIn && onboardingDone === false)
		return <OnboardingPage onComplete={handleOnboardingComplete} />

	return (
		<OSProvider key={profileId}>
			<AgentProvider>
				<DesktopShell onSwitchUser={requestSwitchUser} />
			</AgentProvider>
		</OSProvider>
	)
}

export default App
