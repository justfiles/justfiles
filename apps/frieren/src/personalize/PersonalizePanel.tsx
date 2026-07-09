import { XIcon } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import { openProfile, type ProfileVolume } from '../fs'
import { AgentStep } from './AgentStep'
import { ProfileStep } from './ProfileStep'
import { deriveAge, readUserProfile } from './state'

type View = 'menu' | 'profile' | 'agent'
type UserCtx = { userAge?: number; userGender?: string }

// Opt-in personalization. The desktop opens with seeded defaults (a working
// agent + empty profile), so this is never a gate — the user opens it from the
// desktop menu whenever they want to edit their details or shape the companion.
export function PersonalizePanel({ onClose }: { onClose: () => void }) {
	const [volume, setVolume] = useState<ProfileVolume | null>(null)
	const [view, setView] = useState<View>('menu')
	const [userCtx, setUserCtx] = useState<UserCtx>({})

	const loadCtx = useCallback(async (vol: ProfileVolume) => {
		const profile = await readUserProfile(vol)
		setUserCtx({ userAge: deriveAge(profile?.birth_date), userGender: profile?.gender })
	}, [])

	useEffect(() => {
		let cancelled = false
		void (async () => {
			const vol = await openProfile()
			if (cancelled) return
			setVolume(vol)
			await loadCtx(vol)
		})().catch(() => {})
		return () => {
			cancelled = true
		}
	}, [loadCtx])

	// Steps write soul.md / user.md, which the server agent reads — push them to
	// the backend before returning to the menu.
	const afterStep = async () => {
		if (volume) {
			await loadCtx(volume)
			await volume.flush()
		}
		setView('menu')
	}

	return (
		<div
			className="frn-onb-page"
			role="dialog"
			aria-modal="true"
			aria-label="Personalize"
			style={{
				position: 'fixed',
				inset: 0,
				zIndex: 10000,
				overflowY: 'auto',
				display: 'flex',
				flexDirection: 'column',
				alignItems: 'center',
				justifyContent: 'flex-start'
			}}
		>
			<button
				type="button"
				onClick={onClose}
				aria-label="Close"
				style={{
					position: 'fixed',
					right: 16,
					top: 16,
					zIndex: 1,
					padding: 6,
					border: 'none',
					background: 'transparent',
					color: 'var(--text)',
					opacity: 0.6
				}}
			>
				<XIcon />
			</button>

			{!volume ? (
				<div className="frn-onb-form" style={{ textAlign: 'center', paddingTop: 96 }}>
					<span className="frn-spinner" role="status" aria-label="Loading" />
				</div>
			) : view === 'profile' ? (
				<ProfileStep volume={volume} onDone={() => void afterStep()} />
			) : view === 'agent' ? (
				<AgentStep volume={volume} userCtx={userCtx} onDone={() => void afterStep()} />
			) : (
				<div className="frn-onb-form">
					<div className="frn-card">
						<span className="frn-badge">Personalize</span>
						<h2 className="frn-card-title">Make it yours.</h2>
						<p className="frn-card-desc">
							Optional. Tell us who you are and shape your companion whenever you like — your
							desktop already works without it.
						</p>
						<div className="frn-card-footer">
							<button type="button" className="frn-btn-block" onClick={() => setView('profile')}>
								Your details
							</button>
							<button
								type="button"
								className="frn-btn-primary frn-btn-block"
								onClick={() => setView('agent')}
							>
								Shape your companion
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	)
}
