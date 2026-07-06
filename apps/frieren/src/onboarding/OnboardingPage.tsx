import { useCallback, useEffect, useState } from 'react'
import { openProfile, type ProfileVolume } from '../fs'
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
	const [volume, setVolume] = useState<ProfileVolume | null>(null)
	const [state, setState] = useState<OnboardingState | null>(null)
	const [userCtx, setUserCtx] = useState<{ userAge?: number; userGender?: string }>({})
	const [error, setError] = useState<string | null>(null)

	const refresh = useCallback(
		async (vol: ProfileVolume) => {
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
		let cancelled = false
		void (async () => {
			try {
				const vol = await openProfile()
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
	}, [refresh])

	if (error) {
		return (
			<div
				className="frn-onb-page"
				style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
			>
				<div className="frn-card" role="alert" style={{ maxWidth: 512 }}>
					<strong className="frn-card-title">Onboarding failed</strong>
					<p className="frn-card-desc">{error}</p>
				</div>
			</div>
		)
	}

	if (!volume || state === null) {
		return (
			<div
				className="frn-onb-page"
				style={{
					display: 'flex',
					flexDirection: 'column',
					alignItems: 'center',
					justifyContent: 'center',
					gap: 12,
					padding: 24,
					textAlign: 'center'
				}}
			>
				<span className="frn-spinner" role="status" aria-label="Loading" />
				<p className="frn-muted">Preparing your workspace…</p>
			</div>
		)
	}

	return (
		<div className="frn-onb-page">
			{state === 'user' ? (
				<UserProfileStep volume={volume} onDone={() => void refresh(volume)} />
			) : null}
			{state === 'agent' ? (
				<AgentStep volume={volume} userCtx={userCtx} onDone={() => void refresh(volume)} />
			) : null}
		</div>
	)
}
