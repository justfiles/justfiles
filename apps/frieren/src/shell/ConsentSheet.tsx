import { useState } from 'react'
import type { RunnerCatalogApp } from '../../shared/appstore'

function isFirstParty(id: string): boolean {
	return id.startsWith('justfiles.') || id.startsWith('app.justfiles.frieren.')
}

// One capability line: the resource id and, if scoped, its scopes. This is the
// whole "what it can reach" surface the user consents to — shown from the pinned
// manifest, never by running the app.
function capabilityLabel(cap: { id: string; scopes: string[] }): string {
	return cap.scopes.length ? `${cap.id} · ${cap.scopes.join(', ')}` : cap.id
}

export interface ConsentTarget {
	app: RunnerCatalogApp
	// `install` = first install; `update` = re-consent for a held, capability-
	// escalating update (Step 4 held it rather than auto-applying).
	mode: 'install' | 'update'
}

// The install-consent sheet: the one gate before third-party bytes touch the
// volume. It shows the declared capabilities and Runner-provided provenance from
// static metadata, so nothing runs to render it.
export function ConsentSheet({
	target,
	onConfirm,
	onClose
}: {
	target: ConsentTarget
	onConfirm: () => Promise<void>
	onClose: () => void
}) {
	const { app, mode } = target
	const [busy, setBusy] = useState(false)
	const firstParty = isFirstParty(app.id)
	const caps = Object.values(app.capabilities ?? {})
	const icon = app.iconUrl

	const confirm = async () => {
		if (busy) return
		setBusy(true)
		try {
			await onConfirm()
			onClose()
		} catch {
			setBusy(false) // onConfirm surfaces its own error; keep the sheet open to retry
		}
	}

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label={`${mode === 'update' ? 'Update' : 'Install'} ${app.name}`}
			tabIndex={-1}
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose()
			}}
			onKeyDown={(e) => {
				if (e.key === 'Escape') onClose()
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
					<span className="frn-badge">{firstParty ? 'by Kodama' : 'Verified by justapps.run'}</span>
					<h2 className="frn-card-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
						{icon ? (
							<img src={icon} alt="" style={{ width: 28, height: 28, borderRadius: 6 }} />
						) : null}
						{mode === 'update' ? `${app.name} wants more access` : `Install ${app.name}?`}
					</h2>

					<p className="frn-card-desc">
						{firstParty
							? 'A first-party app from Kodama.'
							: 'Community app — not reviewed by Kodama. It runs with the access it declares below; review before installing.'}
					</p>

					{app.repository ? (
						<p className="frn-card-desc" style={{ opacity: 0.85 }}>
							<a href={app.repository} target="_blank" rel="noreferrer noopener">
								source
							</a>
						</p>
					) : null}

					<div className="frn-card-desc">
						{caps.length ? (
							<>
								<strong>Access it requests</strong>
								<ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
									{caps.map((cap) => (
										<li key={cap.id}>{capabilityLabel(cap)}</li>
									))}
								</ul>
							</>
						) : (
							<span>Requests no capabilities.</span>
						)}
					</div>

					<div className="frn-card-footer">
						<button type="button" className="frn-btn-block" disabled={busy} onClick={onClose}>
							Cancel
						</button>
						<button
							type="button"
							className="frn-btn-primary frn-btn-block"
							disabled={busy}
							onClick={confirm}
						>
							{busy
								? mode === 'update'
									? 'Updating…'
									: 'Installing…'
								: mode === 'update'
									? 'Update'
									: 'Install'}
						</button>
					</div>
				</div>
			</div>
		</div>
	)
}
