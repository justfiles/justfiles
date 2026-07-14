import { XIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import type { CommunityCatalogApp } from '../../shared/appstore'

// First-party apps live under the reserved prefix; the indexer's scope guard makes
// the prefix a safe trust signal, so the client can badge them without a lookup.
function isFirstParty(id: string): boolean {
	return id.startsWith('computer.spud.')
}

function iconUrl(app: CommunityCatalogApp): string | undefined {
	return app.icon
		? `https://cdn.jsdelivr.net/npm/${app.npm}@${app.version}/dist/${app.icon}`
		: undefined
}

// One capability line: the resource id and, if scoped, its scopes. This is the
// whole "what it can reach" surface the user consents to — shown from the pinned
// manifest, never by running the app.
function capabilityLabel(cap: { id: string; scopes: string[] }): string {
	return cap.scopes.length ? `${cap.id} · ${cap.scopes.join(', ')}` : cap.id
}

export interface ConsentTarget {
	app: CommunityCatalogApp
	// `install` = first install; `update` = re-consent for a held, capability-
	// escalating update (Step 4 held it rather than auto-applying).
	mode: 'install' | 'update'
}

// The install-consent sheet: the one gate before third-party bytes touch the
// volume. It shows the declared capabilities, the npm publisher, and either the
// community disclaimer or the "by spud" badge — everything from static catalog
// metadata, so nothing runs to render it.
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
	const icon = iconUrl(app)

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
			className="frn-onb-page"
			role="dialog"
			aria-modal="true"
			aria-label={`${mode === 'update' ? 'Update' : 'Install'} ${app.name}`}
			style={{
				position: 'fixed',
				inset: 0,
				zIndex: 10000,
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center'
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
					<span className="frn-badge">{firstParty ? 'by spud' : `Community · npm/${app.npm}`}</span>
					<h2 className="frn-card-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
						{icon ? (
							<img src={icon} alt="" style={{ width: 28, height: 28, borderRadius: 6 }} />
						) : null}
						{mode === 'update' ? `${app.name} wants more access` : `Install ${app.name}?`}
					</h2>

					<p className="frn-card-desc">
						{firstParty
							? 'A first-party app from spud.'
							: 'Community app — not reviewed by spud. It runs with the access it declares below; review before installing.'}
					</p>

					<p className="frn-card-desc" style={{ opacity: 0.85 }}>
						Publisher:{' '}
						<a
							href={`https://www.npmjs.com/package/${app.npm}`}
							target="_blank"
							rel="noreferrer noopener"
						>
							{app.publisher}
						</a>
						{app.repository ? (
							<>
								{' · '}
								<a href={app.repository} target="_blank" rel="noreferrer noopener">
									source
								</a>
							</>
						) : null}
					</p>

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
