import { useAuth } from '@clerk/clerk-react'
import { useCallback, useEffect, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Spinner } from '@/components/ui/spinner'
import type { SyncedVolume } from '../fs'
import { getFsVolume } from '../fs'
import { AgentStep } from './AgentStep'
import { type OnboardingState, readUserProfile, resolveOnboardingState } from './state'
import { UserProfileStep } from './UserProfileStep'

function deriveAge(birthDate?: string): number | undefined {
	if (!birthDate) return undefined
	const birth = new Date(birthDate)
	if (Number.isNaN(birth.getTime())) return undefined
	const now = new Date()
	let age = now.getFullYear() - birth.getFullYear()
	const monthDiff = now.getMonth() - birth.getMonth()
	if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < birth.getDate())) age -= 1
	return age
}

export function OnboardingPage({ onComplete }: { onComplete: () => void }) {
	const { getToken, userId } = useAuth()

	const [volume, setVolume] = useState<SyncedVolume | null>(null)
	const [state, setState] = useState<OnboardingState | null>(null)
	const [userCtx, setUserCtx] = useState<{ userAge?: number; userGender?: string }>({})
	const [error, setError] = useState<string | null>(null)

	const refresh = useCallback(
		async (vol: SyncedVolume) => {
			const next = await resolveOnboardingState(vol)
			setState(next)
			if (next === 'done') {
				// Onboarding writes soul.md / user.md that the server agent reads;
				// push them to the backend before entering the OS.
				await vol.flush()
				onComplete()
				return
			}
			if (next === 'agent') {
				const profile = await readUserProfile(vol)
				setUserCtx({
					userAge: deriveAge(profile?.birth_date),
					userGender: profile?.gender
				})
			}
		},
		[onComplete]
	)

	useEffect(() => {
		if (!userId) return
		let cancelled = false
		void (async () => {
			try {
				const vol = await getFsVolume(userId, () => getToken())
				if (cancelled) return
				setVolume(vol)
				await refresh(vol)
			} catch (cause) {
				if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
			}
		})()
		return () => {
			cancelled = true
		}
	}, [getToken, userId, refresh])

	if (error) {
		return (
			<div className="flex min-h-dvh items-center justify-center bg-background p-6">
				<Alert variant="destructive" className="max-w-lg">
					<AlertTitle>Onboarding failed</AlertTitle>
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			</div>
		)
	}

	if (!volume || state === null) {
		return (
			<div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background p-6 text-center">
				<Spinner className="size-5" />
				<p className="text-sm text-muted-foreground">Preparing your workspace…</p>
			</div>
		)
	}

	return (
		<div className="min-h-dvh bg-[radial-gradient(circle_at_top,rgba(0,0,0,0.05),transparent_50%)] bg-background dark:bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.08),transparent_50%)]">
			{state === 'user' ? (
				<UserProfileStep volume={volume} onDone={() => void refresh(volume)} />
			) : null}
			{state === 'agent' ? (
				<AgentStep volume={volume} userCtx={userCtx} onDone={() => void refresh(volume)} />
			) : null}
		</div>
	)
}
