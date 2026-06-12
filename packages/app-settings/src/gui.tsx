import type { Client } from '@justfiles/app'
import { defineGUI, injectStyle } from '@justfiles/app/browser'
import type { AgentStatus } from '@justfiles/app/capabilities/ai/admin'
import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { type Category, initialState, type SettingsApp, type SettingsState } from './app.ts'

injectStyle(
	`
.settings { display: flex; height: 100%; width: 100%; overflow: hidden; }
.settings * { box-sizing: border-box; }

.settings-sidebar { flex: 0 0 220px; display: flex; flex-direction: column; gap: 10px; padding: 16px 12px; border-right: 1px solid var(--rule); overflow-y: auto; }
.settings-account { display: flex; align-items: center; gap: 10px; padding: 6px 8px 12px; }
.settings-avatar { flex: 0 0 auto; width: 38px; height: 38px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: var(--rule); opacity: 0.85; }
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

.settings-field { display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
.settings-field-title { opacity: 0.6; }
.settings-select { width: 100%; font: inherit; font-size: 13px; padding: 6px 8px; background: var(--window-bg); border: 1px solid var(--rule); border-radius: 7px; color: inherit; }

.settings-error { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0 0 16px; padding: 8px 12px; color: #b91c1c; font-size: 12px; background: #fef2f2; border: 1px solid #fca5a5; border-radius: 8px; }

.settings button { font: inherit; cursor: default; }
.settings button:disabled { opacity: 0.5; }
.settings-primary-button { background: var(--focus); color: var(--on-focus); border: 1px solid var(--focus); border-radius: 7px; font-size: 13px; padding: 7px 14px; }
.settings-small-button { font-size: 11px; padding: 3px 10px; border: 1px solid var(--rule); border-radius: 6px; background: var(--window-bg); color: inherit; }
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
	{ id: 'ai', label: 'AI Agent', glyph: '✦' },
	{ id: 'email', label: 'Email', glyph: '✉' }
]

function Settings({ state, client }: { state: SettingsState; client: Client<SettingsApp> }) {
	const refreshed = useRef(false)
	useEffect(() => {
		if (refreshed.current) return
		refreshed.current = true
		if (!state.ai) void client.refresh({})
	}, [client, state.ai])

	return (
		<div className="settings">
			<Sidebar category={state.category} client={client} />
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
				{state.category === 'ai' ? <AiAgentPanel state={state} client={client} /> : <EmailPanel />}
			</section>
		</div>
	)
}

function Sidebar({ category, client }: { category: Category; client: Client<SettingsApp> }) {
	return (
		<aside className="settings-sidebar">
			<div className="settings-account">
				<div className="settings-avatar" aria-hidden>
					{/* Placeholder — auth is not implemented yet (no signed-in user). */}
					<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
						<title>User</title>
						<path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0 2c-4.4 0-8 2.2-8 5v1h16v-1c0-2.8-3.6-5-8-5Z" />
					</svg>
				</div>
				<div className="settings-account-text">
					<span className="settings-account-name">Local user</span>
					<span className="settings-account-sub">Not signed in</span>
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

function AiAgentPanel({ state, client }: { state: SettingsState; client: Client<SettingsApp> }) {
	const ai = state.ai
	return (
		<div className="settings-pane">
			<header className="settings-pane-header">
				<h1 className="settings-pane-title">AI Agent</h1>
				<p className="settings-pane-copy">Choose the model that powers your agent.</p>
			</header>
			{ai === null && state.loading ? <p className="settings-muted">Loading…</p> : null}
			{ai && !ai.connected ? <ChatgptSignIn client={client} /> : null}
			{ai?.connected ? <ChatgptConnected ai={ai} client={client} /> : null}
		</div>
	)
}

function ChatgptSignIn({ client }: { client: Client<SettingsApp> }) {
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const signIn = async () => {
		setBusy(true)
		setError(null)
		try {
			await client.signIn({})
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setBusy(false)
		}
	}

	return (
		<section className="settings-card">
			<div className="settings-provider">
				<div className="settings-provider-mark">GPT</div>
				<div className="settings-provider-text">
					<h2 className="settings-card-title">Sign in with ChatGPT</h2>
					<p className="settings-card-copy">
						Use your existing ChatGPT subscription to run the agent on GPT-5 models.
					</p>
				</div>
			</div>
			{busy ? <p className="settings-muted">Complete sign-in in your browser…</p> : null}
			{error ? <p className="settings-card-error">{error}</p> : null}
			<div className="settings-card-actions">
				<button
					type="button"
					className="settings-primary-button"
					disabled={busy}
					onClick={() => void signIn()}
				>
					{busy ? 'Waiting…' : 'Sign in with ChatGPT'}
				</button>
			</div>
		</section>
	)
}

function ChatgptConnected({ ai, client }: { ai: AgentStatus; client: Client<SettingsApp> }) {
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

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

	const signOut = () => {
		if (!window.confirm('Disconnect your ChatGPT account?')) return
		void run(() => client.signOut({}))
	}

	return (
		<section className="settings-card">
			<div className="settings-connected-row">
				<div className="settings-provider">
					<div className="settings-provider-mark">GPT</div>
					<div className="settings-provider-text">
						<h2 className="settings-card-title">ChatGPT</h2>
						<p className="settings-account-status is-connected">
							Connected{ai.account ? ` · ${ai.account}` : ''}
						</p>
					</div>
				</div>
				<button type="button" className="settings-small-button" disabled={busy} onClick={signOut}>
					Sign out
				</button>
			</div>

			<label className="settings-field" htmlFor="settings-model">
				<span className="settings-field-title">Model</span>
				<select
					id="settings-model"
					className="settings-select"
					value={ai.model ?? ''}
					disabled={busy || ai.models.length === 0}
					onChange={(event) => void run(() => client.selectModel({ model: event.target.value }))}
				>
					{ai.models.map((m) => (
						<option key={m.id} value={m.id}>
							{m.name}
						</option>
					))}
				</select>
			</label>
			{error ? <p className="settings-card-error">{error}</p> : null}
		</section>
	)
}

function EmailPanel() {
	return (
		<div className="settings-pane">
			<header className="settings-pane-header">
				<h1 className="settings-pane-title">Email</h1>
				<p className="settings-pane-copy">
					Connect an email provider so the agent can triage your inbox.
				</p>
			</header>
			<section className="settings-card settings-card-empty">
				<p className="settings-muted">Email setup is coming soon.</p>
			</section>
		</div>
	)
}
