import type { Client } from '@justfiles/app'
import { defineGUI } from '@justfiles/app/browser'
import type { IntegrationDescriptor } from '@justfiles/app/capabilities/integrations'
import { type FormEvent, StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { initialState, type SettingsApp, type SettingsState } from './app.ts'

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
		<div
			className="h-full w-full overflow-y-auto"
			style={{
				background: '#ffffff',
				color: 'var(--text)',
				fontFamily: 'var(--font-ui)',
				fontSize: 'var(--text-ui)'
			}}
		>
			<div className="mx-auto flex max-w-2xl flex-col gap-4 px-6 py-8">
				<header className="flex flex-col gap-1">
					<h1 className="text-base font-semibold tracking-tight">Settings</h1>
					<p className="text-xs opacity-60">Connect integrations to expose new bash commands.</p>
				</header>

				{state.loading ? <p className="text-xs opacity-60">Loading…</p> : null}
				{state.error ? (
					<p
						className="flex items-center justify-between gap-2 px-2 py-1 text-xs"
						style={{ color: '#b91c1c' }}
					>
						<span>{state.error}</span>
						<button
							type="button"
							onClick={() => void client.clearError({})}
							className="rounded px-2 py-0.5 text-[11px]"
							style={{ border: '1px solid var(--rule)', background: '#fff' }}
						>
							Dismiss
						</button>
					</p>
				) : null}

				{state.items.map((item) => (
					<IntegrationCard key={item.id} item={item} client={client} />
				))}

				{!state.loading && state.items.length === 0 && !state.error ? (
					<p className="text-xs opacity-60">No integrations available.</p>
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
		<section
			className="flex flex-col gap-3 p-4"
			style={{ background: 'var(--surface)', border: '1px solid var(--rule)' }}
		>
			<header className="flex flex-col gap-0.5">
				<h2 className="text-sm font-semibold tracking-tight">{item.name}</h2>
				<p className="text-xs opacity-60">{item.description}</p>
			</header>

			{item.connectedAccounts.length > 0 ? (
				<ul className="flex flex-col gap-1">
					{item.connectedAccounts.map((account) => (
						<li
							key={account.accountId}
							className="flex items-center justify-between gap-2 px-3 py-2"
							style={{
								background: '#ffffff',
								border: `1px solid ${account.lastError ? '#fca5a5' : 'var(--rule)'}`
							}}
						>
							<div className="flex flex-col">
								<span className="text-xs font-medium">{account.accountId}</span>
								{account.lastError ? (
									<span className="text-[10px]" style={{ color: '#b91c1c' }}>
										{account.lastError}
									</span>
								) : (
									<span className="text-[10px]" style={{ color: '#047857' }}>
										connected
									</span>
								)}
							</div>
							<button
								type="button"
								disabled={busy !== null}
								onClick={() => void disconnect(account.accountId)}
								className="rounded px-2 py-0.5 text-[11px]"
								style={{
									border: '1px solid var(--rule)',
									background: '#fff',
									opacity: busy !== null ? 0.5 : 1
								}}
							>
								{busy === account.accountId ? 'Disconnecting…' : 'Disconnect'}
							</button>
						</li>
					))}
				</ul>
			) : null}

			<form className="flex flex-col gap-2" onSubmit={submit}>
				<label className="flex flex-col gap-1 text-xs" htmlFor={`${item.id}-accountId`}>
					<span className="opacity-60">Account ID</span>
					<input
						id={`${item.id}-accountId`}
						value={accountId}
						onChange={(event) => setAccountId(event.target.value)}
						placeholder={DEFAULT_ACCOUNT}
						className="rounded px-2 py-1 text-xs"
						style={{ background: '#fff', border: '1px solid var(--rule)' }}
					/>
				</label>
				{fields.map(([name, field]) => (
					<label key={name} className="flex flex-col gap-1 text-xs" htmlFor={`${item.id}-${name}`}>
						<span className="opacity-60">
							{name}
							{required.has(name) ? <span style={{ color: '#b91c1c' }}> *</span> : null}
						</span>
						<input
							id={`${item.id}-${name}`}
							type="password"
							autoComplete="off"
							value={values[name] ?? ''}
							onChange={(event) =>
								setValues((prev) => ({ ...prev, [name]: event.target.value.trim() }))
							}
							className="rounded px-2 py-1 text-xs"
							style={{ background: '#fff', border: '1px solid var(--rule)' }}
						/>
						{field.description ? (
							<span className="text-[10px] opacity-50">{field.description}</span>
						) : null}
					</label>
				))}
				{error ? (
					<p className="text-[11px]" style={{ color: '#b91c1c' }}>
						{error}
					</p>
				) : null}
				<div className="flex justify-end">
					<button
						type="submit"
						disabled={busy !== null}
						className="rounded px-3 py-1 text-xs"
						style={{
							background: 'var(--focus)',
							color: 'var(--on-focus)',
							border: '1px solid var(--rule)',
							opacity: busy !== null ? 0.5 : 1
						}}
					>
						{busy !== null ? 'Saving…' : 'Connect'}
					</button>
				</div>
			</form>
		</section>
	)
}
