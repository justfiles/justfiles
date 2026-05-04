import { useAuth } from '@clerk/clerk-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

type CredFieldSchema = { type: 'string'; minLength?: number; description?: string }

interface CredentialsSchema {
	type?: 'object'
	properties?: Record<string, CredFieldSchema>
	required?: string[]
}

interface IntegrationStatus {
	id: string
	name: string
	description: string
	credentialsSchema: CredentialsSchema
	connectedAccounts: ReadonlyArray<{ accountId: string; lastError?: string }>
}

const DEFAULT_ACCOUNT = 'default'

export function SettingsApp() {
	const { getToken } = useAuth()
	const getTokenRef = useRef(getToken)
	getTokenRef.current = getToken

	const [items, setItems] = useState<IntegrationStatus[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)

	const reload = useCallback(async () => {
		setError(null)
		try {
			const token = await getTokenRef.current()
			const res = await fetch('/api/integrations', {
				headers: { Authorization: `Bearer ${token ?? ''}` }
			})
			if (!res.ok) throw new Error(`GET /api/integrations failed: ${res.status}`)
			const list = (await res.json()) as IntegrationStatus[]
			setItems(list)
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause))
		} finally {
			setLoading(false)
		}
	}, [])

	useEffect(() => {
		void reload()
	}, [reload])

	return (
		<div className="h-full w-full overflow-y-auto bg-gradient-to-br from-slate-900 via-slate-950 to-blue-950 px-6 py-8 text-sky-50">
			<div className="mx-auto flex max-w-2xl flex-col gap-4">
				<header className="flex flex-col gap-1">
					<h1 className="text-lg font-semibold tracking-tight">Settings</h1>
					<p className="text-xs text-sky-200/70">
						Connect integrations to expose new bash commands.
					</p>
				</header>

				{loading ? <p className="text-sm text-sky-200/70">Loading…</p> : null}
				{error ? <p className="text-sm text-rose-300">{error}</p> : null}

				{items.map((item) => (
					<IntegrationCard key={item.id} status={item} onChange={reload} />
				))}

				{!loading && items.length === 0 && !error ? (
					<p className="text-sm text-sky-200/70">No integrations available.</p>
				) : null}
			</div>
		</div>
	)
}

function IntegrationCard(props: { status: IntegrationStatus; onChange: () => Promise<void> }) {
	const { status, onChange } = props
	const { getToken } = useAuth()
	const getTokenRef = useRef(getToken)
	getTokenRef.current = getToken

	const fields = Object.entries(status.credentialsSchema.properties ?? {})
	const required = new Set(status.credentialsSchema.required ?? [])
	const [values, setValues] = useState<Record<string, string>>({})
	const [accountId, setAccountId] = useState(DEFAULT_ACCOUNT)
	const [busy, setBusy] = useState(false)
	const [formError, setFormError] = useState<string | null>(null)

	const submit = async (event: React.FormEvent) => {
		event.preventDefault()
		setBusy(true)
		setFormError(null)
		try {
			const token = await getTokenRef.current()
			const body: Record<string, unknown> = { kind: 'static', ...values }
			const res = await fetch(
				`/api/integrations/${encodeURIComponent(status.id)}/${encodeURIComponent(accountId || DEFAULT_ACCOUNT)}`,
				{
					method: 'PUT',
					headers: {
						Authorization: `Bearer ${token ?? ''}`,
						'Content-Type': 'application/json'
					},
					body: JSON.stringify(body)
				}
			)
			if (!res.ok) {
				const message = await res
					.json()
					.then((j) => (typeof j?.error === 'string' ? j.error : null))
					.catch(() => null)
				throw new Error(message ?? `connect failed: ${res.status}`)
			}
			setValues({})
			await onChange()
		} catch (cause) {
			setFormError(cause instanceof Error ? cause.message : String(cause))
		} finally {
			setBusy(false)
		}
	}

	const disconnect = async (account: string) => {
		if (!window.confirm(`Disconnect ${status.name} (${account})?`)) return
		setBusy(true)
		setFormError(null)
		try {
			const token = await getTokenRef.current()
			const res = await fetch(
				`/api/integrations/${encodeURIComponent(status.id)}/${encodeURIComponent(account)}`,
				{
					method: 'DELETE',
					headers: { Authorization: `Bearer ${token ?? ''}` }
				}
			)
			if (!res.ok && res.status !== 204) throw new Error(`disconnect failed: ${res.status}`)
			await onChange()
		} catch (cause) {
			setFormError(cause instanceof Error ? cause.message : String(cause))
		} finally {
			setBusy(false)
		}
	}

	return (
		<section className="flex flex-col gap-3 border border-sky-300/30 bg-slate-950/60 p-4 shadow-[3px_3px_0_rgba(0,0,0,0.45)]">
			<header className="flex flex-col gap-0.5">
				<h2 className="text-sm font-semibold tracking-tight">{status.name}</h2>
				<p className="text-xs text-sky-200/70">{status.description}</p>
			</header>

			{status.connectedAccounts.length > 0 ? (
				<ul className="flex flex-col gap-1">
					{status.connectedAccounts.map((account) => (
						<li
							key={account.accountId}
							className={cn(
								'flex items-center justify-between gap-2 border border-sky-300/20 bg-slate-900/60 px-3 py-2',
								account.lastError && 'border-rose-400/40'
							)}
						>
							<div className="flex flex-col">
								<span className="text-xs font-medium">{account.accountId}</span>
								{account.lastError ? (
									<span className="text-[10px] text-rose-300">{account.lastError}</span>
								) : (
									<span className="text-[10px] text-emerald-300">connected</span>
								)}
							</div>
							<Button
								type="button"
								variant="destructive"
								size="xs"
								disabled={busy}
								onClick={() => disconnect(account.accountId)}
							>
								Disconnect
							</Button>
						</li>
					))}
				</ul>
			) : null}

			<form className="flex flex-col gap-2" onSubmit={submit}>
				<label className="flex flex-col gap-1 text-xs" htmlFor={`${status.id}-accountId`}>
					<span className="text-sky-200/70">Account ID</span>
					<Input
						id={`${status.id}-accountId`}
						value={accountId}
						onChange={(event) => setAccountId(event.target.value)}
						placeholder={DEFAULT_ACCOUNT}
					/>
				</label>
				{fields.map(([name, field]) => (
					<label
						key={name}
						className="flex flex-col gap-1 text-xs"
						htmlFor={`${status.id}-${name}`}
					>
						<span className="text-sky-200/70">
							{name}
							{required.has(name) ? <span className="text-rose-300"> *</span> : null}
						</span>
						<Input
							id={`${status.id}-${name}`}
							type="password"
							autoComplete="off"
							value={values[name] ?? ''}
							onChange={(event) =>
								setValues((prev) => ({ ...prev, [name]: event.target.value.trim() }))
							}
						/>
						{field.description ? (
							<span className="text-[10px] text-sky-200/50">{field.description}</span>
						) : null}
					</label>
				))}
				{formError ? <p className="text-xs text-rose-300">{formError}</p> : null}
				<div className="flex justify-end">
					<Button type="submit" size="sm" disabled={busy}>
						{busy ? 'Saving…' : 'Connect'}
					</Button>
				</div>
			</form>
		</section>
	)
}
