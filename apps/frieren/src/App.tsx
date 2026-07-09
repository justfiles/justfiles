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
	const [chooserForUserId, setChooserForUserId] = useState<string | null>(null)
	const showChooser = chooserForUserId !== null && chooserForUserId === userId

	// Boot the current browser profile immediately — independent of Clerk. If the
	// current profile belongs to an account, its local replica renders before sync.
	useEffect(() => {
		let cancelled = false
		void (async () => {
			await openProfile()
			if (cancelled) return
			setProfileId(activeProfileId())
		})().catch(() => {})
		return () => {
			cancelled = true
		}
	}, [])

	// Auth starts sync for the current account profile. It only switches profiles
	// when Clerk resolves to signed-out or a different signed-in user. There is no
	// onboarding gate: defaults are seeded (server for synced profiles, client for
	// local ones), so every user lands straight on the desktop.
	useEffect(() => {
		if (!isLoaded) return
		let cancelled = false
		if (!isSignedIn || !userId) {
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
				await attachRemoteUser(userId, () => getToken())
				if (!cancelled) setProfileId(activeProfileId())
			} catch {
				if (!cancelled) setProfileId(activeProfileId())
			}
		})()
		return () => {
			cancelled = true
		}
	}, [isLoaded, isSignedIn, userId, getToken])

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

	return (
		<OSProvider key={profileId}>
			<AgentProvider>
				<DesktopShell onSwitchUser={requestSwitchUser} />
			</AgentProvider>
		</OSProvider>
	)
}

export default App
