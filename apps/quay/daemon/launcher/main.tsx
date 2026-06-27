import { StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'

type App = {
	id: string
	name: string
	description?: string
	icon?: string
}

type SystemMessage =
	| { type: 'apps'; apps: App[] }
	| { type: 'error'; message: string }
	| { type: 'hello'; message: string; time: string; uptime: number }

type Connection = 'connecting' | 'ready' | 'disconnected'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root')

createRoot(root).render(
	<StrictMode>
		<Launcher />
	</StrictMode>
)

export function Launcher() {
	const { apps, connection, error } = useSystemApps()
	const [query, setQuery] = useState('')
	const filtered = useMemo(() => filterApps(apps, query), [apps, query])

	return (
		<main className="launcher-page">
			<style>{styles}</style>
			<section className="launcher-panel" aria-label="Quay launcher">
				<div className="app-surface">
					{filtered.length > 0 ? (
						<div className="app-grid">
							{filtered.map((app) => (
								<a className="app-cell" href={appUrl(app.id)} key={app.id} title={app.name}>
									<AppIcon app={app} />
									<span className="app-name">{app.name}</span>
								</a>
							))}
						</div>
					) : (
						<div className="empty-state">
							{connection === 'ready' ? 'No apps found' : 'Connecting to Quay…'}
						</div>
					)}
				</div>
				<label className="composer">
					<span className="sr-only">Search apps</span>
					<input
						onChange={(event) => setQuery(event.currentTarget.value)}
						placeholder="Search apps…"
						value={query}
					/>
				</label>
				<div className="status" role="status">
					{error ?? (connection === 'disconnected' ? 'Reconnecting…' : '')}
				</div>
			</section>
		</main>
	)
}

function useSystemApps() {
	const [apps, setApps] = useState<App[]>([])
	const [connection, setConnection] = useState<Connection>('connecting')
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		let stopped = false
		let retry: ReturnType<typeof setTimeout> | undefined
		let socket: WebSocket | undefined

		const connect = () => {
			setConnection('connecting')
			socket = new WebSocket(
				`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/system`
			)
			socket.onopen = () => {
				setError(null)
			}
			socket.onmessage = (event) => {
				const message = JSON.parse(String(event.data)) as SystemMessage
				if (message.type === 'apps') {
					setApps(message.apps)
					setConnection('ready')
					setError(null)
				} else if (message.type === 'error') {
					setError(message.message)
				}
			}
			socket.onerror = () => socket?.close()
			socket.onclose = () => {
				if (stopped) return
				setConnection('disconnected')
				retry = setTimeout(connect, 1000)
			}
		}

		connect()
		return () => {
			stopped = true
			clearTimeout(retry)
			socket?.close()
		}
	}, [])

	return { apps, connection, error }
}

function filterApps(apps: App[], query: string): App[] {
	const needle = query.trim().toLowerCase()
	if (!needle) return apps
	return apps.filter(
		(app) =>
			app.name.toLowerCase().includes(needle) ||
			app.id.toLowerCase().includes(needle) ||
			app.description?.toLowerCase().includes(needle)
	)
}

function AppIcon({ app }: { app: App }) {
	if (app.icon?.startsWith('data:')) return <img alt="" className="app-icon" src={app.icon} />
	return <span className="app-icon app-glyph">{glyph(app)}</span>
}

function glyph(app: App): string {
	return (app.name.trim() || app.id).slice(0, 1).toUpperCase()
}

function appUrl(id: string): string {
	return `/app/${encodeURIComponent(id)}`
}

const styles = `
:root {
	color-scheme: dark;
}

body {
	margin: 0;
	min-width: 320px;
	background:
		radial-gradient(circle at 50% 0%, rgba(120, 140, 255, 0.18), transparent 34rem),
		linear-gradient(135deg, #17181d, #07080b 70%);
	color: white;
	font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
}

.launcher-page {
	box-sizing: border-box;
	min-height: 100dvh;
	display: flex;
	align-items: flex-end;
	justify-content: center;
	padding: 32px 16px 96px;
}

.launcher-panel {
	position: relative;
	width: min(640px, 100%);
	border: 1px solid rgba(255, 255, 255, 0.12);
	border-radius: 16px;
	background: rgba(18, 18, 22, 0.72);
	box-shadow: 0 24px 80px rgba(0, 0, 0, 0.5);
	backdrop-filter: blur(28px) saturate(1.25);
	overflow: hidden;
}

.launcher-panel::before {
	content: "";
	position: absolute;
	inset: 0;
	background: rgba(255, 255, 255, 0.05);
	pointer-events: none;
}

.app-surface {
	position: relative;
	height: 460px;
	overflow: auto;
	padding: 12px;
}

.app-grid {
	display: grid;
	grid-template-columns: repeat(5, minmax(0, 1fr));
	row-gap: 4px;
}

.app-cell {
	height: 104px;
	border-radius: 20px;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: flex-start;
	gap: 6px;
	padding-top: 12px;
	color: white;
	text-decoration: none;
	outline: none;
}

.app-cell:hover,
.app-cell:focus-visible {
	background: rgba(255, 255, 255, 0.1);
}

.app-cell:focus-visible .app-icon {
	outline: 3px solid var(--focus, #5e9cff);
	outline-offset: 4px;
}

.app-icon {
	width: 64px;
	height: 64px;
	border-radius: 14px;
	object-fit: cover;
	box-shadow: 0 10px 28px rgba(0, 0, 0, 0.24);
}

.app-glyph {
	display: grid;
	place-items: center;
	background: linear-gradient(145deg, rgba(255, 255, 255, 0.28), rgba(255, 255, 255, 0.08));
	font-size: 30px;
	font-weight: 650;
	text-shadow: 0 1px 10px rgba(0, 0, 0, 0.3);
}

.app-name {
	max-width: 100%;
	padding: 0 4px;
	box-sizing: border-box;
	font-size: 12px;
	line-height: 16px;
	text-align: center;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	text-shadow: 0 1px 8px rgba(0, 0, 0, 0.45);
}

.composer {
	position: relative;
	display: block;
	margin: 0 12px 12px;
	border-radius: 14px;
	background: rgba(255, 255, 255, 0.09);
}

.composer input {
	box-sizing: border-box;
	width: 100%;
	height: 48px;
	border: 0;
	padding: 0 16px;
	background: transparent;
	color: white;
	font: inherit;
	font-size: 18px;
	outline: none;
}

.composer input::placeholder {
	color: rgba(255, 255, 255, 0.42);
}

.empty-state {
	height: 100%;
	display: grid;
	place-items: center;
	color: rgba(255, 255, 255, 0.55);
	font-size: 14px;
}

.status {
	position: absolute;
	top: 14px;
	right: 18px;
	min-height: 18px;
	color: rgba(255, 255, 255, 0.55);
	font-size: 12px;
	pointer-events: none;
}

.sr-only {
	position: absolute;
	width: 1px;
	height: 1px;
	padding: 0;
	margin: -1px;
	overflow: hidden;
	clip: rect(0, 0, 0, 0);
	white-space: nowrap;
	border: 0;
}

@media (max-width: 560px) {
	.launcher-page {
		align-items: center;
		padding: 16px;
	}

	.app-grid {
		grid-template-columns: repeat(3, minmax(0, 1fr));
	}
}
`
