import { useState } from 'react'
import { useAgentSession } from '../agent/hooks'
import { dismissMigration, migrateLocalProfileInto } from '../fs'

// The confirm sheet behind the "bring your stuff over?" notification. The pill
// only announces; the durable choice is captured here. "Bring it over" copies the
// signed-out profile's work into this account; "Start fresh" records the decision
// so the offer never returns. Closing without choosing records nothing.
export function MigrationSheet({ onClose }: { onClose: () => void }) {
	const { refreshIdentity } = useAgentSession()
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const bringOver = async () => {
		if (busy) return
		setBusy(true)
		setError(null)
		try {
			await migrateLocalProfileInto()
			// A migrated soul/avatar replaced the identity the account never personalized;
			// the agent identity is cached in React state, so refresh it or the omnibar/avatar
			// keep showing the built-in defaults until a reload.
			await refreshIdentity().catch(() => {})
			onClose()
		} catch {
			setError('Could not copy your data. Please try again.')
			setBusy(false)
		}
	}

	const startFresh = () => {
		if (busy) return
		dismissMigration()
		onClose()
	}

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Bring your local data over"
			tabIndex={-1}
			onClick={(e) => {
				if (e.target === e.currentTarget && !busy) onClose()
			}}
			onKeyDown={(e) => {
				if (e.key === 'Escape' && !busy) onClose()
			}}
			style={{
				position: 'fixed',
				inset: 0,
				zIndex: 10000,
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				background: 'rgba(0, 0, 0, 0.45)',
				backdropFilter: 'blur(2px)'
			}}
		>
			<div className="frn-onb-form">
				<div className="frn-card">
					<span className="frn-badge">Welcome back</span>
					<h2 className="frn-card-title">Bring your stuff over?</h2>
					<p className="frn-card-desc">
						You made some notes and files before signing in. Copy them into this account so they
						sync across your devices — your local workspace stays untouched either way.
					</p>
					{error ? (
						<p className="frn-card-desc" style={{ color: 'var(--danger)' }}>
							{error}
						</p>
					) : null}
					<div className="frn-card-footer">
						<button type="button" className="frn-btn-block" disabled={busy} onClick={startFresh}>
							Start fresh
						</button>
						<button
							type="button"
							className="frn-btn-primary frn-btn-block"
							disabled={busy}
							onClick={() => void bringOver()}
						>
							{busy ? 'Bringing it over…' : 'Bring it over'}
						</button>
					</div>
				</div>
			</div>
		</div>
	)
}
