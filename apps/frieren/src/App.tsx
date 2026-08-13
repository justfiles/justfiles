import { useAuth } from '@clerk/clerk-react'
import { persistStorage } from '@justfiles/fs/storage/idb'
import { useCallback, useEffect, useState } from 'react'
import { AuthWall } from './AuthWall'
import { AgentProvider } from './agent/Provider'
import {
	activeProfileHasRemoteUser,
	activeProfileId,
	activeRemoteUserId,
	attachRemoteUser,
	openBootProfile,
	shouldOfferMigration,
	switchToLocalProfile
} from './fs'
import { notificationStore } from './notifications/store'
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

// After a fresh sign-in, offer to bring the signed-out profile's work into the new
// account. The gate (account empty + local has content + not yet decided) and the
// first-sync wait live in fs.ts; here we just project the offer onto the omnibar
// as a `system` question. Idempotent — the store coalesces by threadId, and the
// gate returns false once a decision is recorded, so this never nags.
async function offerLocalMigration(): Promise<void> {
	if (!(await shouldOfferMigration())) return
	notificationStore.notify({
		id: 'local-migration',
		source: 'system',
		kind: 'question',
		threadId: 'local-migration',
		title: 'Bring your stuff over?',
		body: 'Move the notes and files you made before signing in into this account.'
	})
}

function App() {
	const { isLoaded, isSignedIn, userId, getToken } = useAuth()

	const [profileId, setProfileId] = useState<string | null>(null)
	const [chooserForUserId, setChooserForUserId] = useState<string | null>(null)
	const showChooser = chooserForUserId !== null && chooserForUserId === userId

	// Boot a local profile immediately. A remembered account profile waits for the
	// auth effect below to start sync before it mounts the runtime.
	useEffect(() => {
		let cancelled = false
		void (async () => {
			const id = await openBootProfile()
			if (!cancelled && id) setProfileId(id)
		})().catch(() => {})
		return () => {
			cancelled = true
		}
	}, [])

	// Best-effort storage is evicted whole — IndexedDB and the Cache API together
	// — and Safari drops it after seven days without interaction. A signed-out
	// profile has no replica anywhere, so for it that is the only copy.
	useEffect(() => {
		void persistStorage().then((granted) => {
			if (!granted) console.warn('storage is best-effort: the browser may evict this profile')
		})
	}, [])

	// Auth starts sync for the current account profile. It only switches profiles
	// when Clerk resolves to signed-out or a different signed-in user. There is no
	// onboarding gate: a volume with no identity files reads as the built-in agent
	// (agent-defaults), so every user lands straight on the desktop.
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
				void offerLocalMigration()
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
