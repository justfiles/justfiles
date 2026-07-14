import { XIcon } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import { openProfile, type ProfileVolume } from '../fs'
import { AgentStep } from './AgentStep'
import { ProfileStep } from './ProfileStep'
import { RitualCircle } from './RitualCircle'
import { deriveAge, type IdentityFile, readAgentSoul, readUserProfile } from './state'

type View = 'landing' | 'profile' | 'agent'
type UserCtx = { userAge?: number; userGender?: string }

export function PersonalizePanel({
	onClose,
	onIdentityChange
}: {
	onClose: () => void
	onIdentityChange: () => Promise<void>
}) {
	const [volume, setVolume] = useState<ProfileVolume | null>(null)
	const [view, setView] = useState<View>('landing')
	const [soul, setSoul] = useState<IdentityFile | null>(null)
	const [profile, setProfile] = useState<Record<string, string> | null>(null)
	const [userCtx, setUserCtx] = useState<UserCtx>({})

	const load = useCallback(async (vol: ProfileVolume) => {
		const [nextSoul, nextProfile] = await Promise.all([readAgentSoul(vol), readUserProfile(vol)])
		setSoul(nextSoul)
		setProfile(nextProfile)
		setUserCtx({
			userAge: deriveAge(nextProfile?.birth_date),
			userGender: nextProfile?.gender
		})
	}, [])

	useEffect(() => {
		let cancelled = false
		void (async () => {
			const vol = await openProfile()
			if (cancelled) return
			setVolume(vol)
			await load(vol)
		})().catch(() => {})
		return () => {
			cancelled = true
		}
	}, [load])

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') onClose()
		}
		window.addEventListener('keydown', onKeyDown)
		return () => window.removeEventListener('keydown', onKeyDown)
	}, [onClose])

	const soulBound = soul?.frontmatter.seeded !== 'true' && soul !== null
	const profileBound = profile?.seeded !== 'true' && profile !== null

	const finishProfile = async () => {
		if (!volume) return
		await volume.flush()
		await load(volume)
		await onIdentityChange()
		setView('landing')
	}

	const finishSoul = async () => {
		if (!volume) return
		await volume.flush()
		await onIdentityChange()
		onClose()
	}

	return (
		<div className="frn-ritual" role="dialog" aria-modal="true" aria-label="Personalize">
			<div className="frn-ritual-topbar">
				<span className="frn-ritual-lights" aria-hidden="true">
					<i />
					<i />
					<i />
				</span>
				<span>
					Ritual ·{' '}
					{view === 'landing' ? 'Landing' : view === 'agent' ? 'The Summoning' : 'The Traveler'}
				</span>
			</div>
			<button type="button" className="frn-ritual-close" onClick={onClose}>
				<span>Esc — return to desktop</span>
				<XIcon />
			</button>

			{!volume ? (
				<div className="frn-ritual-loading">
					<span className="frn-spinner" role="status" aria-label="Loading" />
				</div>
			) : view === 'profile' ? (
				<ProfileStep
					volume={volume}
					initial={profile ?? undefined}
					onBack={() => setView('landing')}
					onDone={() => void finishProfile()}
				/>
			) : view === 'agent' ? (
				<AgentStep
					volume={volume}
					userCtx={userCtx}
					initialSoul={soulBound ? soul : null}
					onBack={() => setView('landing')}
					onDone={() => void finishSoul()}
				/>
			) : (
				<main className="frn-ritual-landing">
					<RitualCircle complete={soulBound} />
					<h1>{soulBound ? 'Your companion is bound.' : 'Someone waits to be summoned.'}</h1>
					<p>
						{soulBound
							? 'Return whenever their name, nature, or face should change.'
							: 'Your desktop works without this. But a companion with no name is only an echo of one.'}
					</p>
					<div className="frn-ritual-doors">
						<button type="button" onClick={() => setView('agent')} data-bound={soulBound}>
							<small>{soulBound ? 'Reshape' : 'The Summoning'}</small>
							<strong>{soulBound ? 'Return to their soul' : 'Shape who answers'}</strong>
							<span>Name them, choose their nature, and read the soul before you bind it.</span>
						</button>
						<button
							type="button"
							className="frn-ritual-door-quiet"
							onClick={() => setView('profile')}
							data-bound={profileBound}
						>
							<small>The Traveler</small>
							<strong>{profileBound ? 'Your story is inscribed' : 'Tell them who you are'}</strong>
							<span>Your name, your birth date — so they can know you across the years.</span>
						</button>
					</div>
				</main>
			)}
		</div>
	)
}
