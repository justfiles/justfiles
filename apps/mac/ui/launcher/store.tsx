import { escalatesCapabilities, semverGte } from '@justfiles/app/appstore'
import { useEffect, useMemo, useState } from 'react'

// The App Store surface behind the launcher's store tile. The daemon owns the catalog
// and the install (daemon/store.ts) — this renders rows and posts an id back, so no app
// bytes ever pass through the webview.

// The wire shapes, mirrored here like the launcher's other frames.
export type Capabilities = Record<string, { id: string; scopes: string[] }>

export interface StoreApp {
	id: string
	name: string
	version: string
	description?: string
	iconUrl?: string
	repository?: string
	capabilities?: Capabilities
}

// What the store needs to know about an app already on this Mac.
interface Installed {
	id: string
	version?: string
	capabilities?: Capabilities
}

// A row is an app you don't have, or an update the daemon HELD because the published
// version asks for more access than you consented to. Reconcile skips those, so this
// list is the only place one can be accepted.
interface Row {
	app: StoreApp
	kind: 'install' | 'update'
}

// Updates lead the list: nothing else on this Mac surfaces them.
export function storeRows(catalog: StoreApp[], installed: Installed[]): Row[] {
	const byId = new Map(installed.map((app) => [app.id, app]))
	const rows: Row[] = []
	for (const app of catalog) {
		const have = byId.get(app.id)
		if (!have) {
			rows.push({ app, kind: 'install' })
			continue
		}
		// The direction matters: accepting a row installs the published entry outright, so
		// an older catalog than what's installed must never be offered as an "update".
		const version = have.version ?? '0.0.0'
		if (
			app.version !== version &&
			semverGte(app.version, version) &&
			escalatesCapabilities(have.capabilities, app.capabilities)
		) {
			rows.push({ app, kind: 'update' })
		}
	}
	return rows.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'update' ? -1 : 1))
}

// The catalog, loaded once per visit to the store. An idle launcher never fans out
// across the public catalog.
function useCatalog(): { apps: StoreApp[]; error: string | null; loading: boolean } {
	const [apps, setApps] = useState<StoreApp[] | null>(null)
	const [error, setError] = useState<string | null>(null)
	useEffect(() => {
		let live = true
		fetch('/store')
			.then(async (res) => {
				if (!res.ok) throw new Error(await res.text())
				return (await res.json()) as { apps: StoreApp[] }
			})
			.then(({ apps }) => {
				if (live) setApps(apps)
			})
			.catch((e: unknown) => {
				if (!live) return
				setApps([])
				setError(`App Store unavailable: ${e instanceof Error ? e.message : String(e)}`)
			})
		return () => {
			live = false
		}
	}, [])
	return { apps: apps ?? [], error, loading: apps === null }
}

export function StoreSurface({
	installed,
	installing,
	onInstall,
	onClose
}: {
	installed: Installed[]
	installing: StoreApp[]
	onInstall: (app: StoreApp) => void
	onClose: () => void
}) {
	const { apps, error, loading } = useCatalog()
	const [consent, setConsent] = useState<Row | null>(null)
	const rows = useMemo(() => storeRows(apps, installed), [apps, installed])
	const pending = new Set(installing.map((app) => app.id))
	const empty = loading
		? 'Loading App Store…'
		: (error ?? (rows.length === 0 ? "You've installed every App Store app." : null))

	return (
		<div className="store">
			<style>{styles}</style>
			<div className="store-head">
				<span>App Store · justapps.run</span>
				<button type="button" onClick={onClose}>
					Done
				</button>
			</div>
			{empty ? <div className="store-empty">{empty}</div> : null}
			<ul className="store-list">
				{rows.map(({ app, kind }) => (
					<li key={app.id}>
						<button
							type="button"
							className="store-row"
							disabled={pending.has(app.id)}
							onClick={() => setConsent({ app, kind })}
						>
							<Icon app={app} />
							<span className="store-row-copy">
								<span className="store-row-name">
									{app.name} <span className="store-row-version">{app.version}</span>
								</span>
								<span className="store-row-desc">
									{app.description || 'No description provided by the publisher.'}
								</span>
							</span>
							<span className="store-row-action">
								{pending.has(app.id)
									? 'Installing…'
									: kind === 'update'
										? 'Review update'
										: 'Install'}
							</span>
						</button>
					</li>
				))}
			</ul>
			{consent ? (
				<Consent
					row={consent}
					onConfirm={() => {
						onInstall(consent.app)
						setConsent(null)
					}}
					onClose={() => setConsent(null)}
				/>
			) : null}
		</div>
	)
}

function Icon({ app }: { app: StoreApp }) {
	if (app.iconUrl) return <img alt="" className="store-icon" src={app.iconUrl} />
	return <span className="store-icon store-glyph">{app.name.slice(0, 1).toUpperCase()}</span>
}

// The one gate before third-party bytes reach the Volume: the access the published
// manifest declares, plus its provenance. Static metadata only — nothing runs to
// render this.
function Consent({
	row,
	onConfirm,
	onClose
}: {
	row: Row
	onConfirm: () => void
	onClose: () => void
}) {
	const { app, kind } = row
	const firstParty = app.id.startsWith('justfiles.')
	const caps = Object.values(app.capabilities ?? {})
	return (
		<div
			className="consent"
			role="dialog"
			aria-modal="true"
			aria-label={`${kind === 'update' ? 'Update' : 'Install'} ${app.name}`}
		>
			<div className="consent-card">
				<h2>{kind === 'update' ? `${app.name} wants more access` : `Install ${app.name}?`}</h2>
				<p>
					{firstParty
						? 'A first-party app from Kodama.'
						: 'Community app — not reviewed by Kodama. It runs with the access it declares below.'}
				</p>
				{caps.length ? (
					<>
						<p>
							<strong>Access it requests</strong>
						</p>
						<ul className="consent-caps">
							{caps.map((cap) => (
								<li key={cap.id}>
									{cap.scopes.length ? `${cap.id} · ${cap.scopes.join(', ')}` : cap.id}
								</li>
							))}
						</ul>
					</>
				) : (
					<p>Requests no capabilities.</p>
				)}
				{app.repository ? (
					<p>
						<a href={app.repository} rel="noreferrer noopener" target="_blank">
							source
						</a>
					</p>
				) : null}
				<div className="consent-actions">
					<button type="button" onClick={onClose}>
						Cancel
					</button>
					<button data-primary type="button" onClick={onConfirm}>
						{kind === 'update' ? 'Update' : 'Install'}
					</button>
				</div>
			</div>
		</div>
	)
}

const styles = `
.store {
	height: 100%;
	display: flex;
	flex-direction: column;
	color: rgba(255, 255, 255, 0.9);
}

.store-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 2px 4px 10px;
	color: rgba(255, 255, 255, 0.55);
	font-size: 12px;
	text-transform: uppercase;
	letter-spacing: 0.04em;
}

.store-list {
	flex: 1;
	min-height: 0;
	overflow: auto;
	margin: 0;
	padding: 0;
	list-style: none;
}

.store-row {
	box-sizing: border-box;
	width: 100%;
	display: flex;
	align-items: center;
	gap: 12px;
	border: 0;
	border-radius: 12px;
	padding: 10px;
	background: transparent;
	color: inherit;
	text-align: left;
	cursor: default;
}

.store-row:hover:not(:disabled),
.store-row:focus-visible {
	background: rgba(255, 255, 255, 0.1);
}

.store-row:disabled {
	opacity: 0.5;
}

.store-icon {
	width: 40px;
	height: 40px;
	flex: none;
	border-radius: 10px;
	object-fit: cover;
}

.store-glyph {
	display: grid;
	place-items: center;
	background: rgba(255, 255, 255, 0.16);
	font-size: 20px;
	font-weight: 650;
}

.store-row-copy {
	flex: 1;
	min-width: 0;
	display: flex;
	flex-direction: column;
	gap: 2px;
}

.store-row-version {
	color: rgba(255, 255, 255, 0.4);
	font-size: 12px;
}

.store-row-desc {
	color: rgba(255, 255, 255, 0.55);
	font-size: 12px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.store-row-action {
	flex: none;
	color: rgba(255, 255, 255, 0.7);
	font-size: 12px;
}

.store-empty {
	padding: 24px 10px;
	color: rgba(255, 255, 255, 0.55);
	font-size: 14px;
	text-align: center;
}

.consent {
	position: absolute;
	inset: 0;
	z-index: 10;
	display: grid;
	place-items: center;
	padding: 16px;
	background: rgba(0, 0, 0, 0.5);
	backdrop-filter: blur(2px);
}

.consent-card {
	box-sizing: border-box;
	width: min(420px, 100%);
	max-height: 100%;
	overflow: auto;
	border: 1px solid rgba(255, 255, 255, 0.12);
	border-radius: 14px;
	padding: 18px;
	background: #1c1c20;
	font-size: 13px;
}

.consent-card h2 {
	margin: 0 0 10px;
	font-size: 16px;
}

.consent-card p {
	margin: 0 0 10px;
	color: rgba(255, 255, 255, 0.7);
}

.consent-caps {
	margin: 0 0 10px;
	padding-left: 18px;
	color: rgba(255, 255, 255, 0.7);
}

.consent-actions {
	display: flex;
	justify-content: flex-end;
	gap: 8px;
}
`
