import type { Client } from '@justfiles/app'
import { defineGUI, injectStyle } from '@justfiles/app/browser'
import type { AccountInfo, CapabilityId, ProviderInfo } from '@justfiles/app/capabilities/accounts'
import type { UsageResource } from '@justfiles/app/capabilities/usage'
import type { UserProfile } from '@justfiles/app/capabilities/user'
import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { type Category, initialState, type SettingsApp, type SettingsState } from './app.ts'

// How a provider projects an `ai`-capability account's config for the picker
// (see the host `describe`): the selected model + the list to choose from.
type AiConfig = { model: string; models: { id: string; name: string }[] }

injectStyle(
	`
.settings { display: flex; height: 100%; width: 100%; overflow: hidden; }
.settings * { box-sizing: border-box; }

.settings-sidebar { flex: 0 0 220px; display: flex; flex-direction: column; gap: 10px; padding: 16px 12px; border-right: 1px solid var(--rule); overflow-y: auto; }
.settings-account { display: flex; align-items: center; gap: 10px; padding: 6px 8px 12px; }
.settings-avatar { flex: 0 0 auto; width: 38px; height: 38px; border-radius: 50%; overflow: hidden; display: flex; align-items: center; justify-content: center; background: var(--rule); opacity: 0.85; }
.settings-avatar img { width: 100%; height: 100%; object-fit: cover; }
.settings-account-text { display: flex; flex-direction: column; min-width: 0; }
.settings-account-name { font-size: 13px; font-weight: 600; letter-spacing: -0.01em; }
.settings-account-sub { font-size: 11px; opacity: 0.5; }

.settings-nav { display: flex; flex-direction: column; gap: 2px; }
.settings-nav-item { display: flex; align-items: center; gap: 10px; width: 100%; padding: 7px 10px; border: 1px solid transparent; border-radius: 7px; background: transparent; font: inherit; font-size: 13px; text-align: left; color: inherit; }
.settings-nav-item:hover { background: var(--surface); }
.settings-nav-item[data-active="true"] { background: var(--focus); color: var(--on-focus); }
.settings-nav-glyph { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 5px; font-size: 12px; }

.settings-detail { flex: 1 1 auto; overflow-y: auto; padding: 28px 32px; }
.settings-pane { display: flex; flex-direction: column; gap: 18px; max-width: 560px; }
.settings-pane-header { display: flex; flex-direction: column; gap: 4px; }
.settings-pane-title { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.02em; }
.settings-pane-copy, .settings-muted { margin: 0; font-size: 12px; opacity: 0.55; }

.settings-card { display: flex; flex-direction: column; gap: 14px; padding: 18px; background: var(--surface); border: 1px solid var(--rule); border-radius: 10px; }
.settings-card-empty { align-items: center; padding: 32px; }
.settings-card-title { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: -0.01em; }
.settings-card-copy { margin: 0; font-size: 12px; opacity: 0.6; }
.settings-card-error { margin: 0; font-size: 11px; color: #b91c1c; }
.settings-card-actions { display: flex; justify-content: flex-start; }

.settings-provider { display: flex; align-items: center; gap: 12px; }
.settings-provider-mark { flex: 0 0 auto; width: 40px; height: 40px; border-radius: 9px; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; background: #10a37f; color: #fff; }
.settings-provider-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }

.settings-connected-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.settings-account-status { margin: 0; font-size: 11px; }
.settings-account-status.is-connected { color: #047857; }

.settings-caps { display: flex; flex-wrap: wrap; gap: 14px; }
.settings-cap-toggle { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.settings-cap-toggle input { margin: 0; }

.settings-field { display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
.settings-field-title { opacity: 0.6; }
.settings-select { width: 100%; font: inherit; font-size: 13px; padding: 6px 8px; background: var(--window-bg); border: 1px solid var(--rule); border-radius: 7px; color: inherit; }

.settings-error { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0 0 16px; padding: 8px 12px; color: #b91c1c; font-size: 12px; background: #fef2f2; border: 1px solid #fca5a5; border-radius: 8px; }

.settings button { font: inherit; cursor: default; }
.settings button:disabled { opacity: 0.5; }
.settings-primary-button { background: var(--focus); color: var(--on-focus); border: 1px solid var(--focus); border-radius: 7px; font-size: 13px; padding: 7px 14px; }
.settings-small-button { font-size: 11px; padding: 3px 10px; border: 1px solid var(--rule); border-radius: 6px; background: var(--window-bg); color: inherit; }

.settings-meter-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.settings-meter-used { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
.settings-meter-limit { font-size: 12px; opacity: 0.55; }
.settings-meter-bar { position: relative; height: 8px; border-radius: 999px; background: var(--rule); overflow: hidden; }
.settings-meter-fill { position: absolute; inset: 0 auto 0 0; border-radius: 999px; background: var(--focus); transition: width 0.2s ease; }
.settings-meter-fill[data-exceeded="true"] { background: #b91c1c; }
.settings-meter-sub { margin: 0; font-size: 11px; opacity: 0.55; }
.settings-tier-badge { align-self: flex-start; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; padding: 3px 9px; border-radius: 999px; background: var(--focus); color: var(--on-focus); }
`,
	'app-settings'
)

// Merge onto initialState so a persisted state missing newer keys (e.g. an
// older build's shape carried across a rewrite) still has every field — a bare
// `'category' in value` check would hand back a stale object whose `ai` is
// `undefined`, wedging the panel before the first refresh.
const stateOrInitial = (value: unknown): SettingsState =>
	value && typeof value === 'object'
		? { ...initialState, ...(value as Partial<SettingsState>) }
		: initialState

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

const CATEGORIES: { id: Category; label: string; glyph: string }[] = [
	{ id: 'accounts', label: 'Accounts', glyph: '@' },
	{ id: 'usage', label: 'Usage', glyph: '%' }
]

const CAP_LABEL: Record<CapabilityId, string> = {
	email: 'Email',
	calendar: 'Calendar',
	ai: 'AI'
}

function Settings({ state, client }: { state: SettingsState; client: Client<SettingsApp> }) {
	const refreshed = useRef(false)
	useEffect(() => {
		if (refreshed.current) return
		refreshed.current = true
		void client.loadUser({})
		void client.loadProviders({})
		void client.loadAccounts({})
		void client.loadUsage({})
	}, [client])

	return (
		<div className="settings">
			<Sidebar category={state.category} user={state.user} client={client} />
			<section className="settings-detail">
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
				{state.category === 'accounts' ? <AccountsPanel state={state} client={client} /> : null}
				{state.category === 'usage' ? <UsagePanel state={state} client={client} /> : null}
			</section>
		</div>
	)
}

function Sidebar({
	category,
	user,
	client
}: {
	category: Category
	user: UserProfile | null
	client: Client<SettingsApp>
}) {
	return (
		<aside className="settings-sidebar">
			<div className="settings-account">
				<div className="settings-avatar" aria-hidden>
					{user?.avatarUrl ? (
						<img src={user.avatarUrl} alt="" />
					) : (
						<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
							<title>User</title>
							<path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0 2c-4.4 0-8 2.2-8 5v1h16v-1c0-2.8-3.6-5-8-5Z" />
						</svg>
					)}
				</div>
				<div className="settings-account-text">
					<span className="settings-account-name">
						{user?.name ?? (user ? 'User' : 'Local user')}
					</span>
					<span className="settings-account-sub">{user ? 'Signed in' : 'Not signed in'}</span>
				</div>
			</div>
			<nav className="settings-nav">
				{CATEGORIES.map((c) => (
					<button
						key={c.id}
						type="button"
						className="settings-nav-item"
						data-active={category === c.id || undefined}
						onClick={() => void client.selectCategory({ category: c.id })}
					>
						<span className="settings-nav-glyph" aria-hidden>
							{c.glyph}
						</span>
						<span>{c.label}</span>
					</button>
				))}
			</nav>
		</aside>
	)
}

function AccountsPanel({ state, client }: { state: SettingsState; client: Client<SettingsApp> }) {
	const connectedIds = new Set(state.accounts.map((a) => a.providerId))
	const available = state.providers.filter((p) => !connectedIds.has(p.id))
	return (
		<div className="settings-pane">
			<header className="settings-pane-header">
				<h1 className="settings-pane-title">Accounts</h1>
				<p className="settings-pane-copy">Connect an account, then choose what it powers.</p>
			</header>
			{state.loading ? <p className="settings-muted">Loading…</p> : null}
			{!state.loading && state.providers.length === 0 ? (
				<section className="settings-card settings-card-empty">
					<p className="settings-muted">No account providers available here.</p>
				</section>
			) : null}
			{state.accounts.map((account) => (
				<ConnectedAccount
					key={account.accountId}
					account={account}
					provider={state.providers.find((p) => p.id === account.providerId)}
					client={client}
				/>
			))}
			{available.map((provider) => (
				<ProviderConnectForm key={provider.id} provider={provider} client={client} />
			))}
		</div>
	)
}

const formatUsd = (n: number) => `$${n.toFixed(2)}`

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`
	const units = ['KB', 'MB', 'GB', 'TB']
	let v = n / 1024
	let i = 0
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024
		i++
	}
	return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`
}

function formatTokens(n: number): string {
	if (n < 1000) return String(n)
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
	return `${(n / 1_000_000).toFixed(1)}M`
}

function UsagePanel({ state, client }: { state: SettingsState; client: Client<SettingsApp> }) {
	const usage = state.usage
	return (
		<div className="settings-pane">
			<header className="settings-pane-header">
				<h1 className="settings-pane-title">Usage</h1>
				<p className="settings-pane-copy">Your AI and storage usage against your plan.</p>
			</header>
			{!usage ? (
				<section className="settings-card">
					<p className="settings-muted">{state.error ? 'Couldn’t load usage.' : 'Loading…'}</p>
					<div className="settings-card-actions">
						<button
							type="button"
							className="settings-small-button"
							onClick={() => void client.loadUsage({})}
						>
							Retry
						</button>
					</div>
				</section>
			) : (
				<>
					<span className="settings-tier-badge">{usage.tier} plan</span>
					<Meter
						title="AI this month"
						resource={usage.ai}
						format={formatUsd}
						overHint="Limit reached — resets next month, or upgrade your plan."
						sub={`${formatTokens(usage.aiTokens)} tokens · ${usage.aiRequests} requests · ${usage.window}`}
					/>
					<Meter
						title="Storage"
						resource={usage.storage}
						format={formatBytes}
						overHint="Over your storage limit — delete files or notes, or upgrade your plan."
						sub="Deduplicated content across your files and notes."
					/>
					<div className="settings-card-actions">
						<button
							type="button"
							className="settings-small-button"
							onClick={() => void client.loadUsage({})}
						>
							Refresh
						</button>
					</div>
				</>
			)}
		</div>
	)
}

function Meter({
	title,
	resource,
	format,
	overHint,
	sub
}: {
	title: string
	resource: UsageResource
	format: (n: number) => string
	overHint: string
	sub: string
}) {
	const pct = Math.min(100, Math.round(resource.fraction * 100))
	return (
		<section className="settings-card">
			<div className="settings-meter-head">
				<h2 className="settings-card-title">{title}</h2>
				<span className="settings-meter-used">
					{format(resource.used)}
					<span className="settings-meter-limit">
						{resource.limit !== null ? ` / ${format(resource.limit)}` : ' · unlimited'}
					</span>
				</span>
			</div>
			{resource.limit !== null ? (
				<div className="settings-meter-bar">
					<div
						className="settings-meter-fill"
						data-exceeded={resource.exceeded || undefined}
						style={{ width: `${pct}%` }}
					/>
				</div>
			) : null}
			<p className="settings-meter-sub">
				{resource.exceeded ? `${overHint} ` : ''}
				{sub}
			</p>
		</section>
	)
}

function ConnectedAccount({
	account,
	provider,
	client
}: {
	account: AccountInfo
	provider?: ProviderInfo
	client: Client<SettingsApp>
}) {
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const caps = provider?.capabilities ?? account.enabled
	// `ai` may carry a model picker as its per-account config (host `describe`) — or
	// none, when the provider owns the model choice (e.g. platform AI). Guard on the
	// model list so a picker-less ai provider doesn't crash the card.
	const aiConfig =
		account.enabled.includes('ai') &&
		Array.isArray((account.config.ai as AiConfig | undefined)?.models)
			? (account.config.ai as AiConfig)
			: undefined

	const run = async (fn: () => Promise<void>) => {
		setBusy(true)
		setError(null)
		try {
			await fn()
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setBusy(false)
		}
	}

	const disconnect = () => {
		// No `window.confirm` — the GUI runs in a sandboxed iframe that blocks modals, so
		// a confirm() is ignored and would make Disconnect a silent no-op. Disconnect is
		// reversible (just reconnect), so act directly.
		void run(() => client.disconnectAccount({ accountId: account.accountId }))
	}

	return (
		<section className="settings-card">
			<div className="settings-connected-row">
				<div className="settings-provider">
					<div className="settings-provider-mark">
						{(provider?.name ?? account.providerId ?? account.accountId ?? '?')
							.slice(0, 2)
							.toUpperCase()}
					</div>
					<div className="settings-provider-text">
						<h2 className="settings-card-title">
							{provider?.name ?? account.providerId ?? account.accountId}
						</h2>
						<p className="settings-account-status is-connected">Connected · {account.accountId}</p>
					</div>
				</div>
				{provider?.builtin ? null : (
					<button
						type="button"
						className="settings-small-button"
						disabled={busy}
						onClick={disconnect}
					>
						Disconnect
					</button>
				)}
			</div>
			<div className="settings-caps">
				{caps.map((cap) => {
					const on = account.enabled.includes(cap)
					return (
						<label key={cap} className="settings-cap-toggle">
							<input
								type="checkbox"
								checked={on}
								disabled={busy}
								onChange={() =>
									void run(() =>
										client.setAccountEnabled({
											accountId: account.accountId,
											capability: cap,
											enabled: !on
										})
									)
								}
							/>
							<span>{CAP_LABEL[cap]}</span>
						</label>
					)
				})}
			</div>
			{aiConfig ? (
				<label className="settings-field" htmlFor={`model-${account.accountId}`}>
					<span className="settings-field-title">Model</span>
					<select
						id={`model-${account.accountId}`}
						className="settings-select"
						value={aiConfig.model}
						disabled={busy || aiConfig.models.length === 0}
						onChange={(e) =>
							void run(() =>
								client.setAccountEnabled({
									accountId: account.accountId,
									capability: 'ai',
									enabled: true,
									config: { model: e.target.value }
								})
							)
						}
					>
						{aiConfig.models.map((m) => (
							<option key={m.id} value={m.id}>
								{m.name}
							</option>
						))}
					</select>
				</label>
			) : null}
			{account.lastError ? <p className="settings-card-error">{account.lastError}</p> : null}
			{error ? <p className="settings-card-error">{error}</p> : null}
		</section>
	)
}

function ProviderConnectForm({
	provider,
	client
}: {
	provider: ProviderInfo
	client: Client<SettingsApp>
}) {
	const fields = provider.credentialsSchema
		? Object.entries(provider.credentialsSchema.properties)
		: []
	const [values, setValues] = useState<Record<string, string>>({})
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const connect = async () => {
		setBusy(true)
		setError(null)
		try {
			await client.connectAccount(
				provider.authKind === 'form'
					? { providerId: provider.id, credentials: values }
					: { providerId: provider.id }
			)
			setValues({})
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setBusy(false)
		}
	}

	return (
		<section className="settings-card">
			<div className="settings-provider">
				<div className="settings-provider-mark">{provider.name.slice(0, 2).toUpperCase()}</div>
				<div className="settings-provider-text">
					<h2 className="settings-card-title">{provider.name}</h2>
					<p className="settings-card-copy">
						Backs {provider.capabilities.map((c) => CAP_LABEL[c]).join(' · ')}.
					</p>
				</div>
			</div>
			{fields.map(([key, field]) => (
				<label key={key} className="settings-field" htmlFor={`connect-${provider.id}-${key}`}>
					<span className="settings-field-title">
						{key}
						{field.description ? ` — ${field.description}` : ''}
					</span>
					<input
						id={`connect-${provider.id}-${key}`}
						className="settings-select"
						type="password"
						autoComplete="off"
						value={values[key] ?? ''}
						disabled={busy}
						onChange={(e) => setValues((prev) => ({ ...prev, [key]: e.target.value }))}
					/>
				</label>
			))}
			{error ? <p className="settings-card-error">{error}</p> : null}
			<div className="settings-card-actions">
				<button
					type="button"
					className="settings-primary-button"
					disabled={busy}
					onClick={() => void connect()}
				>
					{busy ? 'Connecting…' : `Connect ${provider.name}`}
				</button>
			</div>
		</section>
	)
}
