import { SignInButton, SignUpButton, useClerk } from '@clerk/clerk-react'
import { useState } from 'react'

export function AuthWall({ onDismiss }: { onDismiss?: () => void } = {}) {
	const clerk = useClerk()
	const sessions = clerk.client?.signedInSessions ?? []
	const [busy, setBusy] = useState(false)

	const pick = async (sessionId: string) => {
		setBusy(true)
		try {
			await clerk.setActive({ session: sessionId })
			onDismiss?.()
		} finally {
			setBusy(false)
		}
	}

	return (
		<div className="frn-backdrop">
			{sessions.length > 0 ? (
				<>
					<div className="frn-auth-grid">
						{sessions.map((s) => {
							const u = s.user
							const name =
								u?.firstName || u?.fullName || u?.primaryEmailAddress?.emailAddress || 'User'
							return (
								<div key={s.id} className="frn-auth-user">
									<button
										type="button"
										onClick={() => void pick(s.id)}
										disabled={busy}
										className="frn-auth-avatar"
										title={name}
									>
										{u?.hasImage ? <img src={u.imageUrl} alt="" /> : name.slice(0, 1).toUpperCase()}
									</button>
									<span className="frn-auth-name">{name}</span>
								</div>
							)
						})}

						<div className="frn-auth-user">
							<SignInButton>
								<button
									type="button"
									className="frn-auth-avatar frn-auth-avatar-add"
									title="Add account"
								>
									+
								</button>
							</SignInButton>
							<span className="frn-auth-name frn-auth-name-muted">Other…</span>
						</div>
					</div>

					{onDismiss ? (
						<button type="button" data-ghost onClick={onDismiss} className="frn-auth-cancel">
							Cancel
						</button>
					) : null}
				</>
			) : (
				<div className="frn-auth-signedout">
					<div className="frn-auth-avatar">?</div>
					<div className="frn-auth-actions">
						<SignInButton>
							<button type="button" data-primary>
								Sign in
							</button>
						</SignInButton>
						<SignUpButton>
							<button type="button">Create account</button>
						</SignUpButton>
					</div>
				</div>
			)}
		</div>
	)
}
