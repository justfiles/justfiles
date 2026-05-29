import { SignInButton, SignUpButton, useClerk } from '@clerk/clerk-react'
import { useState } from 'react'
import { Button } from './components/ui/button'
import { destroyFsVolume } from './fs'

export function AuthWall({ onDismiss }: { onDismiss?: () => void } = {}) {
	const clerk = useClerk()
	const sessions = clerk.client?.signedInSessions ?? []
	const [busy, setBusy] = useState(false)

	const pick = async (sessionId: string) => {
		setBusy(true)
		try {
			await destroyFsVolume()
			await clerk.setActive({ session: sessionId })
			onDismiss?.()
		} finally {
			setBusy(false)
		}
	}

	return (
		<div
			className="flex min-h-dvh flex-col items-center justify-center px-6 text-white"
			style={{
				background:
					'radial-gradient(ellipse at 50% 35%, rgba(255,255,255,0.08), transparent 65%), var(--desktop-bg)'
			}}
		>
			{sessions.length > 0 ? (
				<>
					<div className="flex flex-wrap items-start justify-center gap-x-10 gap-y-6">
						{sessions.map((s) => {
							const u = s.user
							const name =
								u?.firstName || u?.fullName || u?.primaryEmailAddress?.emailAddress || 'User'
							return (
								<div key={s.id} className="flex w-28 flex-col items-center gap-3">
									<button
										type="button"
										onClick={() => void pick(s.id)}
										disabled={busy}
										className="flex size-24 items-center justify-center overflow-hidden rounded-full border border-white/30 bg-white/5 text-3xl font-light text-white shadow-[0_2px_10px_rgba(0,0,0,0.35)] transition hover:border-white/80 hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent disabled:opacity-60"
										title={name}
									>
										{u?.hasImage ? (
											<img src={u.imageUrl} alt="" className="size-full object-cover" />
										) : (
											name.slice(0, 1).toUpperCase()
										)}
									</button>
									<span className="w-full truncate text-center text-sm font-medium tracking-wide drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]">
										{name}
									</span>
								</div>
							)
						})}

						<div className="flex w-28 flex-col items-center gap-3">
							<SignInButton>
								<button
									type="button"
									onClickCapture={() => void destroyFsVolume()}
									className="flex size-24 items-center justify-center rounded-full border border-dashed border-white/30 bg-white/[0.03] text-3xl font-light text-white/60 transition hover:border-white/70 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
									title="Add account"
								>
									+
								</button>
							</SignInButton>
							<span className="w-full truncate text-center text-sm font-medium text-white/70 drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]">
								Other…
							</span>
						</div>
					</div>

					{onDismiss ? (
						<button
							type="button"
							onClick={onDismiss}
							className="mt-12 text-xs text-white/55 hover:text-white/90"
						>
							Cancel
						</button>
					) : null}
				</>
			) : (
				<div className="flex flex-col items-center gap-6">
					<div className="flex size-24 items-center justify-center rounded-full border border-white/25 bg-white/[0.03] text-3xl font-light text-white/50">
						?
					</div>
					<div className="flex items-center gap-2">
						<SignInButton>
							<Button type="button" className="min-w-28">
								Sign in
							</Button>
						</SignInButton>
						<SignUpButton>
							<Button type="button" variant="outline" className="min-w-28">
								Create account
							</Button>
						</SignUpButton>
					</div>
				</div>
			)}
		</div>
	)
}
