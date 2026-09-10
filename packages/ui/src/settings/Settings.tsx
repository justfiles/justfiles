import { GameboyAvatar } from '@justfiles/avatar/react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { AgentPane, useDrafting } from './agent-pane.tsx'
import { AppearancePane } from './appearance-pane.tsx'
import type { SettingsOptions } from './client.ts'
import {
	type Category,
	hasBothOrigins,
	originKind,
	type SettingsActions,
	type SettingsState
} from './model.ts'
import { SystemPane } from './system-pane.tsx'
import type {
	AccountInfo,
	CapabilityId,
	ConnectRef,
	ConnectState,
	ProviderInfo,
	UsageResource
} from './types.ts'
import { useSettings } from './useSettings.ts'

export type { SettingsOptions } from './client.ts'
import './gui.css'
type AiConfig = { model: string; models: { id: string; name: string }[] }
const CATEGORIES: { id: Category; label: string; glyph: string }[] = [
	{ id: 'accounts', label: 'Accounts', glyph: '@' },
	{ id: 'appearance', label: 'Appearance', glyph: '◐' },
	{ id: 'system', label: 'System', glyph: 'ⓘ' }
]

const CAP_LABEL: Record<CapabilityId, string> = {
	email: 'Email',
	calendar: 'Calendar',
	ai: 'AI text',
	image: 'Images'
}

export function Settings({
	getToken,
	local,
	category = 'agent',
	onCategoryChange
}: SettingsOptions & {
	category?: Category
	onCategoryChange?: (category: Category) => void
}) {
	const { state, actions: client } = useSettings({ getToken, local }, category, onCategoryChange)
	const drafting = useDrafting(client, state.facts)
	return (
		<div className="settings">
			<Sidebar state={state} client={client} />
			<section className="settings-detail">
				{state.error || drafting.error ? (
					<p className="settings-error">
						<span>{state.error ?? drafting.error}</span>
						<button
							type="button"
							onClick={() => {
								void client.clearError({})
								drafting.dismiss()
							}}
							data-size="sm"
						>
							Dismiss
						</button>
					</p>
				) : null}
				{state.category === 'agent' ? (
					<AgentPane state={state} client={client} drafting={drafting} />
				) : null}
				{state.category === 'accounts' ? <AccountsPanel state={state} client={client} /> : null}
				{state.category === 'account' ? <AccountPane state={state} client={client} /> : null}

				{state.category === 'appearance' ? <AppearancePane client={client} /> : null}
				{state.category === 'system' ? <SystemPane client={client} /> : null}
			</section>
		</div>
	)
}
function AgentNavGlyph() {
	return (
		<span className="settings-nav-glyph settings-nav-face" aria-hidden>
			<GameboyAvatar />
		</span>
	)
}

function Sidebar({ state, client }: { state: SettingsState; client: SettingsActions }) {
	const { category, user } = state
	const name = user?.name ?? (user ? 'User' : 'Local user')
	const status = user ? 'Signed in' : 'Not signed in'
	return (
		<aside className="settings-sidebar">
			<button
				type="button"
				className="settings-account"
				data-active={category === 'account' || undefined}
				aria-label={`Account — ${name}, ${status}`}
				onClick={() => void client.selectCategory({ category: 'account' })}
			>
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
					<span className="settings-account-name">{name}</span>
					<span className="settings-account-sub">{status}</span>
				</div>
			</button>
			<nav className="settings-nav">
				<button
					type="button"
					className="settings-nav-item"
					data-active={category === 'agent' || undefined}
					onClick={() => void client.selectCategory({ category: 'agent' })}
				>
					<AgentNavGlyph />
					<span>{state.soul && !state.soul.seeded ? state.soul.name : 'Agent'}</span>
				</button>
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

function AccountsPanel({ state, client }: { state: SettingsState; client: SettingsActions }) {
	const connectedIds = new Set(state.accounts.map((a) => a.providerId))
	const available = state.providers.filter((p) => !connectedIds.has(p.id))
	const twoLanes = hasBothOrigins(state.accounts)
	return (
		<div className="settings-pane">
			<header className="settings-pane-header">
				<h1 className="settings-pane-title">Accounts</h1>
				<p className="settings-pane-copy">Connect an account, then choose what it powers.</p>
				{twoLanes ? (
					<p className="settings-pane-copy">
						Cloud accounts are available on your devices; local accounts stay on this one.
					</p>
				) : null}
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
function resetsInText(resetsAt: number | null): string {
	if (resetsAt === null) return ''
	const ms = resetsAt - Date.now()
	if (ms <= 0) return ''
	const mins = Math.round(ms / 60000)
	if (mins < 60) return `Resets in ${mins}m · `
	const hrs = Math.floor(mins / 60)
	if (hrs < 24) {
		const rem = mins % 60
		return `Resets in ${hrs}h${rem ? ` ${rem}m` : ''} · `
	}
	return `Resets in ${Math.round(hrs / 24)}d · `
}
function aiHeadLabel(r: UsageResource): string {
	return r.limit === null ? 'Unlimited' : `${Math.round(r.fraction * 100)}%`
}
function AccountPane({ state, client }: { state: SettingsState; client: SettingsActions }) {
	const usage = state.usage
	return (
		<div className="settings-pane">
			<header className="settings-pane-header">
				<h1 className="settings-pane-title">Account</h1>
				<p className="settings-pane-copy">You, your plan, and what your agent knows about you.</p>
			</header>
			<AboutYou state={state} client={client} />
			<h2 className="settings-card-title">Usage</h2>
			{!state.usageAvailable ? (
				<section className="settings-card">
					<p className="settings-muted">This device keeps no usage meter.</p>
				</section>
			) : !usage ? (
				<section className="settings-card">
					<p className="settings-muted">{state.usageError ? 'Couldn’t load usage.' : 'Loading…'}</p>
					<div className="settings-card-actions">
						<button type="button" data-size="sm" onClick={() => void client.loadUsage({})}>
							Retry
						</button>
					</div>
				</section>
			) : (
				<>
					<span className="settings-tier-badge">{usage.tier} plan</span>
					<Meter
						title="5h limit"
						resource={usage.aiBurst}
						value={aiHeadLabel(usage.aiBurst)}
						overHint="5h limit reached — it resets soon, or upgrade your plan."
						sub={`${resetsInText(usage.aiBurst.resetsAt)}Short-term burst limit`}
					/>
					<Meter
						title="Weekly limit"
						resource={usage.aiWeekly}
						value={aiHeadLabel(usage.aiWeekly)}
						overHint="Weekly limit reached — it resets soon, or upgrade your plan."
						sub={`${resetsInText(usage.aiWeekly.resetsAt)}${formatTokens(usage.aiTokens)} tokens · ${usage.aiRequests} requests`}
					/>
					<Meter
						title="Storage"
						resource={usage.storage}
						value={
							<>
								{formatBytes(usage.storage.used)}
								<span className="settings-meter-limit">
									{usage.storage.limit !== null
										? ` / ${formatBytes(usage.storage.limit)}`
										: ' · unlimited'}
								</span>
							</>
						}
						overHint="Over your storage limit — delete files or notes, or upgrade your plan."
						sub="Deduplicated content across your files and notes."
					/>
					<div className="settings-card-actions">
						<button type="button" data-size="sm" onClick={() => void client.loadUsage({})}>
							Refresh
						</button>
					</div>
				</>
			)}
		</div>
	)
}
function AboutYou({ state, client }: { state: SettingsState; client: SettingsActions }) {
	const facts = state.facts
	const [name, setName] = useState('')
	const [birthDate, setBirthDate] = useState('')
	const [saved, setSaved] = useState(false)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const editing = useRef(false)
	useEffect(() => {
		if (editing.current || !facts) return
		setName(facts.name)
		setBirthDate(facts.birthDate)
	}, [facts])
	const save = async (patch: { name?: string; birthDate?: string; gender?: 'female' | 'male' }) => {
		setBusy(true)
		setError(null)
		setSaved(false)
		try {
			await client.saveFacts(patch)
			setSaved(true)
			setTimeout(() => setSaved(false), 1200)
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error))
		} finally {
			setBusy(false)
		}
	}

	return (
		<section className="settings-card">
			<div className="settings-connected-row">
				<h2 className="settings-card-title">About you</h2>
				<span className="agent-saved" data-on={saved || undefined}>
					Saved
				</span>
			</div>
			<label className="settings-field" htmlFor="about-name">
				<span className="settings-field-title">Your name</span>
				<input
					id="about-name"
					disabled={busy}
					className="settings-select"
					value={name}
					onFocus={() => {
						editing.current = true
					}}
					onChange={(e) => setName(e.target.value)}
					onBlur={() => {
						editing.current = false
						if (name !== facts?.name) void save({ name })
					}}
				/>
			</label>
			<label className="settings-field" htmlFor="about-birth">
				<span className="settings-field-title">Birth date — a date, never an age</span>
				<input
					id="about-birth"
					disabled={busy}
					className="settings-select"
					type="date"
					value={birthDate}
					onChange={(e) => {
						setBirthDate(e.target.value)
						void save({ birthDate: e.target.value })
					}}
				/>
			</label>
			<div className="settings-field">
				<span className="settings-field-title">Gender</span>
				<div className="agent-seg">
					{(['female', 'male'] as const).map((option) => (
						<button
							key={option}
							type="button"
							className="agent-seg-button"
							data-on={facts?.gender === option}
							disabled={busy}
							onClick={() => void save({ gender: option })}
						>
							{option === 'female' ? 'Female' : 'Male'}
						</button>
					))}
				</div>
			</div>
			<p className="settings-card-copy">
				Written to your volume as <span style={{ fontFamily: 'var(--font-mono)' }}>user.md</span>.
				Only what you put here — nothing is inferred.
			</p>
			{error ? (
				<p className="settings-card-error" role="alert">
					Could not save changes: {error}
				</p>
			) : null}
		</section>
	)
}

function Meter({
	title,
	resource,
	value,
	overHint,
	sub
}: {
	title: string
	resource: UsageResource
	value: ReactNode
	overHint: string
	sub: string
}) {
	const pct = Math.min(100, Math.round(resource.fraction * 100))
	return (
		<section className="settings-card">
			<div className="settings-meter-head">
				<h2 className="settings-card-title">{title}</h2>
				<span className="settings-meter-used">{value}</span>
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
function originLabel(account: AccountInfo): string {
	return originKind(account) === 'device' ? 'This device' : 'Cloud'
}

function originHint(account: AccountInfo): string {
	if (originKind(account) !== 'device')
		return 'Stored in your cloud account and available on your devices'
	const label = account.origin?.kind === 'device' ? account.origin.label : undefined
	return label ? `Connected on ${label} only` : 'Connected on this device only'
}

function ConnectedAccount({
	account,
	provider,
	client
}: {
	account: AccountInfo
	provider?: ProviderInfo
	client: SettingsActions
}) {
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [reconnect, setReconnect] = useState(false)
	const caps = provider?.capabilities ?? account.enabled
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
						<p className="settings-account-status is-connected">
							{provider?.builtin ? 'Connected' : `Connected · ${account.accountId}`}
						</p>
					</div>
				</div>
				<span className="settings-origin-badge" title={originHint(account)}>
					{originLabel(account)}
				</span>
				{provider?.builtin ? null : (
					<button type="button" data-danger data-size="sm" disabled={busy} onClick={disconnect}>
						Disconnect
					</button>
				)}
			</div>
			{provider?.authKind === 'interactive' ? (
				<button type="button" data-size="sm" onClick={() => setReconnect(!reconnect)}>
					{reconnect ? 'Close sign-in' : 'Reconnect'}
				</button>
			) : null}
			{reconnect && provider ? <ProviderConnectForm provider={provider} client={client} /> : null}
			<div className="settings-caps">
				{caps.map((cap) => {
					const on = account.enabled.includes(cap)
					const floor = (cap === 'ai' || cap === 'image') && on && provider?.builtin === true
					return (
						<label
							key={cap}
							className="settings-cap-toggle"
							title={
								floor
									? cap === 'image'
										? 'Images use the built-in provider independently of AI text'
										: 'Always available — enable another provider’s AI text to take over'
									: undefined
							}
						>
							<input
								type="checkbox"
								checked={on}
								disabled={busy || floor}
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
					{account.providerId === 'chatgpt' ? (
						<span>
							Codex models; availability depends on your plan. This list differs from the ChatGPT
							app.
						</span>
					) : null}
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
	client: SettingsActions
}) {
	const fields = provider.credentialsSchema
		? Object.entries(provider.credentialsSchema.properties)
		: []
	const [values, setValues] = useState<Record<string, string>>({})
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [attempt, setAttempt] = useState<ConnectState | null>(null)
	const [pollError, setPollError] = useState<string | null>(null)
	const opened = useRef<string | null>(null)
	const pending = useRef<ConnectRef | null>(null)
	useEffect(
		() => () => {
			const ref = pending.current
			pending.current = null
			if (ref) void client.cancelAccountConnection(ref).catch(() => {})
		},
		[client]
	)
	useEffect(() => {
		if (!attempt || pending.current?.operationId !== attempt.operationId) return
		if (attempt.status !== 'pending') {
			pending.current = null
			setBusy(false)
			setPollError(null)
			if (attempt.status === 'connected') {
				setError(null)
				void client.loadAccounts().catch((error) => setError(String(error)))
			}
			if (attempt.status === 'failed') setError(attempt.message)
			if (attempt.status === 'expired') setError('Sign-in expired. Please try again.')
			return
		}
		const timer = setTimeout(
			async () => {
				try {
					const next = await client.readAccountConnection(attempt)
					if (pending.current?.operationId !== attempt.operationId) return
					setPollError(null)
					setAttempt(next)
				} catch (err) {
					if (pending.current?.operationId !== attempt.operationId) return
					setPollError(err instanceof Error ? err.message : String(err))
					setAttempt({ ...attempt })
				}
			},
			Math.max(1000, attempt.prompt?.intervalMs ?? 1000)
		)
		return () => clearTimeout(timer)
	}, [attempt, client])

	useEffect(() => {
		if (
			provider.id !== 'chatgpt' ||
			attempt?.status !== 'pending' ||
			!attempt.prompt ||
			attempt.prompt.userCode ||
			pending.current?.operationId !== attempt.operationId ||
			opened.current === attempt.operationId
		)
			return
		opened.current = attempt.operationId
		void client.openAccountConnection(attempt).catch(() => {
			if (pending.current?.operationId === attempt.operationId)
				setError('Could not open your browser. Try Reopen sign-in page or use a code instead.')
		})
	}, [attempt, client, provider.id])

	const connect = async (method?: 'device_code') => {
		setBusy(true)
		setError(null)
		setAttempt(null)
		try {
			if (provider.authKind === 'interactive') {
				const ref = { providerId: provider.id, operationId: crypto.randomUUID() }
				pending.current = ref
				setPollError(null)
				const next = await client.beginAccountConnection({ ...ref, method })
				if (pending.current?.operationId !== ref.operationId) {
					await client.cancelAccountConnection(ref)
					return
				}
				setAttempt(next)
				return
			}
			await client.connectAccount(
				provider.authKind === 'form'
					? { providerId: provider.id, credentials: values }
					: { providerId: provider.id }
			)
			setValues({})
		} catch (err) {
			pending.current = null
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			if (!pending.current) setBusy(false)
		}
	}

	return (
		<section className="settings-card">
			<div className="settings-provider">
				<div className="settings-provider-mark">{provider.name.slice(0, 2).toUpperCase()}</div>
				<div className="settings-provider-text">
					<h2 className="settings-card-title">{provider.name}</h2>
					<p className="settings-card-copy">
						{provider.id === 'chatgpt' ? (
							'Sign in once for web and Mac. AI text uses your Codex allowance; images use Just Computer.'
						) : (
							<>Backs {provider.capabilities.map((c) => CAP_LABEL[c]).join(' · ')}.</>
						)}
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
			{attempt?.status === 'pending' ? (
				<div className="settings-field" aria-live="polite">
					<p>
						{attempt.prompt?.userCode
							? 'Continue to OpenAI, paste this code, and approve sign-in. Settings will update automatically.'
							: 'Waiting for you to sign in and approve access in your browser…'}
					</p>
					{attempt.prompt?.userCode ? (
						<label>
							Sign-in code
							<input
								className="settings-select"
								readOnly
								value={attempt.prompt.userCode}
								onFocus={(e) => e.currentTarget.select()}
							/>
						</label>
					) : null}
					{attempt.prompt ? (
						<>
							<button
								type="button"
								onClick={() => {
									setError(null)
									// Start both actions in the click so browser permissions keep the user gesture.
									if (attempt.prompt?.userCode) {
										const copy = navigator.clipboard?.writeText(attempt.prompt.userCode)
										void (copy ?? Promise.reject()).catch(() =>
											setError(
												'Could not copy the code. Select and copy it above, then paste it on OpenAI.'
											)
										)
									}
									void client
										.openAccountConnection(attempt)
										.catch(() =>
											setError('Could not open your browser. Copy the sign-in address below.')
										)
								}}
							>
								{attempt.prompt.userCode ? 'Copy code and continue' : 'Reopen sign-in page'}
							</button>
							<details>
								<summary>Browser didn’t open?</summary>
								<label>
									Sign-in address
									<input
										className="settings-select"
										readOnly
										value={attempt.prompt.verificationUrl}
										onFocus={(e) => e.currentTarget.select()}
									/>
								</label>
							</details>
						</>
					) : (
						<p>Waiting for the sign-in page…</p>
					)}
					{provider.id === 'chatgpt' && attempt.prompt && !attempt.prompt.userCode ? (
						<button type="button" onClick={() => void connect('device_code')}>
							Use a code instead
						</button>
					) : null}
					<button
						type="button"
						onClick={() => {
							void client
								.cancelAccountConnection(attempt)
								.then(() => {
									if (pending.current?.operationId !== attempt.operationId) return
									pending.current = null
									setAttempt(null)
									setBusy(false)
									setError(null)
									setPollError(null)
								})
								.catch((err) => setError(String(err)))
						}}
					>
						Cancel sign-in
					</button>
				</div>
			) : null}
			{attempt?.status === 'connected' ? <p role="status">Connected.</p> : null}
			{error || pollError ? <p className="settings-card-error">{error || pollError}</p> : null}
			<div className="settings-card-actions">
				<button type="button" data-primary disabled={busy} onClick={() => void connect()}>
					{busy
						? 'Connecting…'
						: provider.id === 'chatgpt'
							? 'Use your ChatGPT subscription'
							: `Connect ${provider.name}`}
				</button>
			</div>
		</section>
	)
}
