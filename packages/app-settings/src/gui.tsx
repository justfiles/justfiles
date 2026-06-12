import type { Client } from '@justfiles/app'
import { defineGUI, injectStyle } from '@justfiles/app/browser'
import type { IntegrationDescriptor } from '@justfiles/app/capabilities/integrations'
import { type FormEvent, StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { initialState, type SettingsApp, type SettingsState } from './app.ts'

injectStyle(
	`
.settings { height: 100%; width: 100%; overflow-y: auto; }
.settings * { box-sizing: border-box; }
.settings-inner { display: flex; flex-direction: column; gap: 16px; max-width: 672px; margin: 0 auto; padding: 32px 24px; }
.settings-header, .settings-card-header { display: flex; flex-direction: column; gap: 4px; }
.settings-title { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
.settings-copy, .settings-muted { margin: 0; font-size: 12px; opacity: 0.6; }
.settings-error { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0; padding: 4px 8px; color: #b91c1c; font-size: 12px; }
.settings-small-button { font-size: 11px; padding: 2px 8px; }
.settings-card { display: flex; flex-direction: column; gap: 12px; padding: 16px; background: var(--surface); border: 1px solid var(--rule); border-radius: 8px; }
.settings-card-title { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: -0.01em; }
.settings-account-list { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.settings-account-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px; background: var(--window-bg); border: 1px solid var(--rule); border-radius: 6px; }
.settings-account-row[data-error="true"] { border-color: #fca5a5; }
.settings-account-text { display: flex; flex-direction: column; }
.settings-account-id { font-size: 12px; font-weight: 500; }
.settings-account-status { font-size: 10px; }
.settings-account-status.is-error, .settings-card-error, .settings-required { color: #b91c1c; }
.settings-account-status.is-connected { color: #047857; }
.settings-form { display: flex; flex-direction: column; gap: 8px; }
.settings-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.settings-field-title { opacity: 0.6; }
.settings-field input { width: 100%; font: inherit; font-size: 12px; }
.settings-description { font-size: 10px; opacity: 0.5; }
.settings-card-error { margin: 0; font-size: 11px; }
.settings-submit-row { display: flex; justify-content: flex-end; }
.settings-primary-button { background: var(--focus); color: var(--on-focus); border-color: var(--focus); font-size: 12px; padding: 4px 12px; }
.settings button { font: inherit; cursor: default; }
.settings button:disabled { opacity: 0.5; }
`,
	'app-settings'
)

const stateOrInitial = (value: unknown): SettingsState =>
	value && typeof value === 'object' && 'items' in value ? (value as SettingsState) : initialState

export const gui = defineGUI<SettingsApp>({
	mount(el, state, ctx) {
		const root = createRoot(el)
		const render = (next: SettingsState | null) =>
			root.render(
				<StrictMode>
					<Settings state={stateOrInitial(next)} client={ctx.client} />
				</StrictMode>
			)
		render(state)
		return {
			update: render,
			unmount() {
				root.unmount()
			}
		}
	}
})

function Settings({ state, client }: { state: SettingsState; client: Client<SettingsApp> }) {
	const refreshed = useRef(false)
	useEffect(() => {
		if (refreshed.current) return
		refreshed.current = true
		if (state.items.length === 0) void client.refresh({})
	}, [client, state.items.length])

	return (
		<div className="settings">
			<div className="settings-inner">
				<header className="settings-header">
					<h1 className="settings-title">Settings</h1>
					<p className="settings-copy">Connect integrations to expose new bash commands.</p>
				</header>

				{state.loading ? <p className="settings-muted">Loading…</p> : null}
				{state.error ? (
					<p className="settings-error">
						<span>{state.error}</span>
						<button
							type="button"
							onClick={() => void client.clearError({})}
							className="settings-small-button"
						>
							Dismiss
						</button>
					</p>
				) : null}

				{state.items.map((item) => (
					<IntegrationCard key={item.id} item={item} client={client} />
				))}

				{!state.loading && state.items.length === 0 && !state.error ? (
					<p className="settings-muted">No integrations available.</p>
				) : null}
			</div>
		</div>
	)
}

const DEFAULT_ACCOUNT = 'default'

function IntegrationCard({
	item,
	client
}: {
	item: IntegrationDescriptor
	client: Client<SettingsApp>
}) {
	const fields = Object.entries(item.credentialsSchema.properties ?? {})
	const required = new Set(item.credentialsSchema.required ?? [])
	const [values, setValues] = useState<Record<string, string>>({})
	const [accountId, setAccountId] = useState(DEFAULT_ACCOUNT)
	const [busy, setBusy] = useState<string | null>(null)
	// connect/disconnect are procedures that reject on failure (the chain no
	// longer folds errors into state), so the card surfaces them inline.
	const [error, setError] = useState<string | null>(null)

	const submit = async (event: FormEvent) => {
		event.preventDefault()
		const account = accountId || DEFAULT_ACCOUNT
		setBusy(account)
		setError(null)
		try {
			await client.connect({ id: item.id, accountId: account, credentials: values })
			setValues({})
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setBusy(null)
		}
	}

	const disconnect = async (account: string) => {
		if (!window.confirm(`Disconnect ${item.name} (${account})?`)) return
		setBusy(account)
		setError(null)
		try {
			await client.disconnect({ id: item.id, accountId: account })
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setBusy(null)
		}
	}

	return (
		<section className="settings-card">
			<header className="settings-card-header">
				<h2 className="settings-card-title">{item.name}</h2>
				<p className="settings-copy">{item.description}</p>
			</header>

			{item.connectedAccounts.length > 0 ? (
				<ul className="settings-account-list">
					{item.connectedAccounts.map((account) => (
						<li
							key={account.accountId}
							className="settings-account-row"
							data-error={account.lastError ? 'true' : undefined}
						>
							<div className="settings-account-text">
								<span className="settings-account-id">{account.accountId}</span>
								{account.lastError ? (
									<span className="settings-account-status is-error">{account.lastError}</span>
								) : (
									<span className="settings-account-status is-connected">connected</span>
								)}
							</div>
							<button
								type="button"
								disabled={busy !== null}
								onClick={() => void disconnect(account.accountId)}
								className="settings-small-button"
							>
								{busy === account.accountId ? 'Disconnecting…' : 'Disconnect'}
							</button>
						</li>
					))}
				</ul>
			) : null}

			<form className="settings-form" onSubmit={submit}>
				<label className="settings-field" htmlFor={`${item.id}-accountId`}>
					<span className="settings-field-title">Account ID</span>
					<input
						id={`${item.id}-accountId`}
						value={accountId}
						onChange={(event) => setAccountId(event.target.value)}
						placeholder={DEFAULT_ACCOUNT}
					/>
				</label>
				{fields.map(([name, field]) => (
					<label key={name} className="settings-field" htmlFor={`${item.id}-${name}`}>
						<span className="settings-field-title">
							{name}
							{required.has(name) ? <span className="settings-required"> *</span> : null}
						</span>
						<input
							id={`${item.id}-${name}`}
							type="password"
							autoComplete="off"
							value={values[name] ?? ''}
							onChange={(event) =>
								setValues((prev) => ({ ...prev, [name]: event.target.value.trim() }))
							}
						/>
						{field.description ? (
							<span className="settings-description">{field.description}</span>
						) : null}
					</label>
				))}
				{error ? <p className="settings-card-error">{error}</p> : null}
				<div className="settings-submit-row">
					<button type="submit" disabled={busy !== null} className="settings-primary-button">
						{busy !== null ? 'Saving…' : 'Connect'}
					</button>
				</div>
			</form>
		</section>
	)
}
