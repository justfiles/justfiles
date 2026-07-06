import { useAuth } from '@clerk/clerk-react'
import { useCallback, useEffect, useState } from 'react'
import { AuthWall } from './AuthWall'
import { AgentProvider } from './agent/Provider'
import {
	activeProfileHasRemoteUser,
	activeProfileId,
	activeRemoteUserId,
	attachRemoteUser,
	openProfile,
	switchToLocalProfile
} from './fs'
import { OnboardingPage } from './onboarding/OnboardingPage'
import { resolveOnboardingState } from './onboarding/state'
import { OSProvider } from './os/Provider'
import { DesktopShell } from './shell/DesktopShell'

function LoadingScreen({ label }: { label: string }) {
	return (
		<div className="frn-backdrop">
			<span className="frn-spinner" role="status" aria-label="Loading" />
			<p className="frn-backdrop-note">{label}</p>
		</div>
	)
}

function App() {
	const { isLoaded, isSignedIn, userId, getToken } = useAuth()

	const [profileId, setProfileId] = useState<string | null>(null)
	const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null)
	const [chooserForUserId, setChooserForUserId] = useState<string | null>(null)
	const showChooser = chooserForUserId !== null && chooserForUserId === userId

	// Boot the current browser profile immediately — independent of Clerk. If the
	// current profile belongs to an account, its local replica renders before sync.
	useEffect(() => {
		let cancelled = false
		void (async () => {
			const vol = await openProfile()
			let cachedOnboardingDone = false
			if (activeProfileHasRemoteUser()) {
				try {
					cachedOnboardingDone = (await resolveOnboardingState(vol)) === 'done'
				} catch {}
			}
			if (cancelled) return
			if (cachedOnboardingDone) setOnboardingDone(true)
			setProfileId(activeProfileId())
		})().catch(() => {})
		return () => {
			cancelled = true
		}
	}, [])

	// Auth starts sync for the current account profile. It only switches profiles
	// when Clerk resolves to signed-out or a different signed-in user.
	useEffect(() => {
		if (!isLoaded) return
		let cancelled = false
		if (!isSignedIn || !userId) {
			setOnboardingDone(null)
			if (activeProfileId() && !activeProfileHasRemoteUser()) return
			setProfileId(null)
			void switchToLocalProfile()
				.then(() => {
					if (!cancelled) setProfileId(activeProfileId())
				})
				.catch(() => {})
			return () => {
				cancelled = true
			}
		}
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
				if (!cancelled) {
					setProfileId(activeProfileId())
					setOnboardingDone(false)
				}
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

	const remoteUserId = activeRemoteUserId()
	if (!profileId) return <LoadingScreen label="Starting…" />
	if (isLoaded && !isSignedIn && remoteUserId) return <LoadingScreen label="Switching workspace…" />
	if (isLoaded && isSignedIn && userId && remoteUserId !== userId)
		return <LoadingScreen label="Loading workspace…" />
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
