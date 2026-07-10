import { useAuth } from '@clerk/clerk-react'
import { XIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import { activeProfileHasRemoteUser, factoryReset, resetTakeMine, resetTakeTheirs } from '../fs'

// Debug-gated shell panel for the three destructive volume resets
// (docs/sync-reset-generation.md). Shell-level, not the sandboxed Settings app —
// these reach IDB, the sync lifecycle, and location.reload(). "Take theirs" /
// "take mine" need a synced profile; a local-only workspace only offers factory
// reset (wipe local + reload). Confirmations are the debug-phase mitigation; the
// prod UI adds typed-to-confirm and a "close other devices first" note.
export function ResetPanel({ onClose }: { onClose: () => void }) {
	const { getToken } = useAuth()
	const synced = activeProfileHasRemoteUser()
	const [busy, setBusy] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)

	const run = (label: string, confirmMsg: string, op: () => Promise<void>) => async () => {
		if (busy) return
		if (!confirm(confirmMsg)) return
		setBusy(label)
		setError(null)
		try {
			await op()
			onClose()
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e))
			setBusy(null)
		}
	}

	const token = () => getToken()

	return (
		<div
			className="frn-onb-page"
			role="dialog"
			aria-modal="true"
			aria-label="Reset sync"
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

			<div className="frn-onb-form">
				<div className="frn-card">
					<span className="frn-badge">Debug · Reset sync</span>
					<h2 className="frn-card-title">Reset this volume.</h2>
					<p className="frn-card-desc">
						Destructive. These throw away data and can't be undone. Close your other devices first —
						a stale one can re-push what you just cleared.
					</p>
					{error ? (
						<p className="frn-card-desc" role="alert" style={{ color: 'var(--danger, #d33)' }}>
							{error}
						</p>
					) : null}
					<div className="frn-card-footer">
						<button
							type="button"
							className="frn-btn-block"
							disabled={!synced || busy !== null}
							onClick={run(
								'theirs',
								'Take theirs: discard THIS device’s local changes and re-pull the server. Continue?',
								() => resetTakeTheirs()
							)}
						>
							{busy === 'theirs' ? 'Taking theirs…' : 'Take theirs (re-pull server)'}
						</button>
						<button
							type="button"
							className="frn-btn-block"
							disabled={!synced || busy !== null}
							onClick={run(
								'mine',
								'Take mine: overwrite the server with THIS device’s volume. Every other device will discard its copy. Continue?',
								() => resetTakeMine(token)
							)}
						>
							{busy === 'mine' ? 'Publishing…' : 'Take mine (republish to server)'}
						</button>
						<button
							type="button"
							className="frn-btn-primary frn-btn-block"
							disabled={busy !== null}
							onClick={run(
								'factory',
								synced
									? 'Factory reset: wipe the server AND every device, then reseed the built-in apps. This deletes everything. Continue?'
									: 'Factory reset: wipe this local workspace and reload. This deletes everything. Continue?',
								() => factoryReset(token)
							)}
						>
							{busy === 'factory' ? 'Resetting…' : 'Factory reset (wipe everything)'}
						</button>
					</div>
					{!synced ? (
						<p className="frn-card-desc" style={{ opacity: 0.7 }}>
							Sign in to a synced profile to take-theirs or take-mine. A local-only workspace can
							only factory-reset itself.
						</p>
					) : null}
				</div>
			</div>
		</div>
	)
}
