import { UserIcon } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import agentAvatarUrl from '../agent/agent-avatar.png'
import { openProfile, type ProfileVolume } from '../fs'
import { AgentStep } from './AgentStep'
import { ProfileStep } from './ProfileStep'
import {
	deriveAge,
	type IdentityFile,
	readAgentSoul,
	readAvatarUrl,
	readUserProfile
} from './state'

type View = 'landing' | 'profile' | 'agent'
type UserCtx = { userAge?: number; userGender?: string }

const TITLES: Record<View, string> = {
	landing: 'Personalize',
	agent: 'The Summoning',
	profile: 'The Traveler'
}

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
	const [avatar, setAvatar] = useState<string | null>(null)
	const [userCtx, setUserCtx] = useState<UserCtx>({})

	const load = useCallback(async (vol: ProfileVolume) => {
		const [nextSoul, nextProfile, nextAvatar] = await Promise.all([
			readAgentSoul(vol),
			readUserProfile(vol),
			readAvatarUrl(vol)
		])
		setSoul(nextSoul)
		setProfile(nextProfile)
		setAvatar(nextAvatar)
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
		<div className="frn-sheet" role="dialog" aria-modal="true" aria-label="Personalize">
			<div
				className="ds-window ds-window-framed frn-sheet-window"
				data-view={view}
				data-focused="true"
			>
				<div className="ds-window-titlebar">
					<div className="ds-window-controls">
						<button
							type="button"
							className="ds-window-control ds-window-control-close"
							onClick={onClose}
							aria-label="Close"
						/>
					</div>
					<span className="ds-window-title">{TITLES[view]}</span>
					<span className="ds-window-spacer" />
				</div>
				<div className="frn-sheet-body">
					{!volume ? (
						<div className="frn-sheet-loading">
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
						<main className="frn-roster">
							<div className="frn-roster-main">
								<header className="frn-roster-head">
									<span className="frn-sheet-label">Party roster</span>
									<p>{soulBound ? 'Your companion is bound.' : 'Someone waits to be summoned.'}</p>
								</header>
								<div className="frn-roster-slots">
									<button
										type="button"
										className="frn-slot frn-sunken"
										onClick={() => setView('agent')}
									>
										<span className="frn-portrait frn-slot-portrait">
											<img
												src={avatar ?? agentAvatarUrl}
												alt=""
												data-pixel={!avatar}
												data-bound={soulBound}
											/>
										</span>
										<span className="frn-slot-copy">
											<strong>The Companion</strong>
											<span>
												{soulBound
													? 'Return whenever their name, nature, or face should change.'
													: 'Name them, choose their nature, and read the soul before you bind it.'}
											</span>
											<small className="frn-slot-status" data-bound={soulBound}>
												{soulBound ? 'Bound' : 'Unbound'}
											</small>
										</span>
									</button>
									<button
										type="button"
										className="frn-slot frn-sunken"
										onClick={() => setView('profile')}
									>
										<span className="frn-portrait frn-slot-portrait" data-empty="true">
											<UserIcon />
										</span>
										<span className="frn-slot-copy">
											<strong>The Traveler</strong>
											<span>Your name and birth date — so they can know you across the years.</span>
											<small className="frn-slot-status" data-bound={profileBound}>
												{profileBound ? 'Inscribed' : 'Not inscribed'}
											</small>
										</span>
									</button>
								</div>
							</div>
							<footer className="frn-sheet-status">
								<span>
									Your desktop works without this — but a companion with no name is only an echo of
									one.
								</span>
								<span>
									<kbd>Esc</kbd> Return to the desktop
								</span>
							</footer>
						</main>
					)}
				</div>
			</div>
		</div>
	)
}
