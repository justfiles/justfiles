import { useAuth } from '@clerk/clerk-react'
import { useCallback, useEffect, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Spinner } from '@/components/ui/spinner'
import type { Volume } from '../fs'
import { createFsVolume } from '../fs'
import { AgentStep } from './AgentStep'
import { UserProfileStep } from './UserProfileStep'
import { readUserProfile, resolveOnboardingState, type OnboardingState } from './state'

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
	const { getToken } = useAuth()

	const [volume, setVolume] = useState<Volume | null>(null)
	const [state, setState] = useState<OnboardingState | null>(null)
	const [userCtx, setUserCtx] = useState<{ userAge?: number; userGender?: string }>({})
	const [error, setError] = useState<string | null>(null)

	const refresh = useCallback(
		async (vol: Volume) => {
			const next = await resolveOnboardingState(vol)
			setState(next)
			if (next === 'done') {
				onComplete()
				return
			}
			if (next === 'agent') {
				const profile = await readUserProfile(vol)
				setUserCtx({
					userAge: deriveAge(profile?.birth_date),
					userGender: profile?.gender,
				})
			}
		},
		[onComplete]
	)

	useEffect(() => {
		let cancelled = false
		void (async () => {
			try {
				const vol = await createFsVolume(() => getToken())
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
	}, [getToken, refresh])

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
