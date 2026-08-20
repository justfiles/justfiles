import '@justfiles/design/design.css'
import '@justfiles/design/mac.css'
import { Transcript } from '@justfiles/ui/Transcript'
import { StrictMode, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import appStoreIcon from '../../../../app_store.svg'
import { useAgentChat } from './agentChat'
import { StoreSurface } from './appStore'
import { type App, useSystemApps } from './system'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root')

createRoot(root).render(
	<StrictMode>
		<Launcher />
	</StrictMode>
)

export function Launcher() {
	const { apps, connection, error } = useSystemApps()
	const chat = useAgentChat()
	const [query, setQuery] = useState('')
	const [chatOpen, setChatOpen] = useState(false)
	// The store is transient like the chat: Escape or Done leaves it.
	const [storeOpen, setStoreOpen] = useState(false)
	const filtered = useMemo(() => filterApps(apps, query), [apps, query])
	const text = query.trim()
	const noAppMatch = text !== '' && filtered.length === 0
	const showChat = noAppMatch || (chatOpen && text === '')
	const showStore = storeOpen && !showChat && text === ''
	const status =
		error ??
		(showChat ? chat.error : null) ??
		(connection === 'disconnected' ? 'Reconnecting…' : '')

	const submit = (event: React.FormEvent) => {
		event.preventDefault()
		if (showChat) {
			if (text && !chat.isStreaming) {
				setChatOpen(true)
				setQuery('')
				void chat.send(text)
			}
			return
		}
		if (text && filtered[0]) location.href = appUrl(filtered[0].id)
	}

	return (
		<main className="launcher-page">
			<style>{styles}</style>
			<section className="launcher-panel" aria-label="Kodama launcher">
				<div className="app-surface">
					{showChat ? (
						<ChatSurface chat={chat} />
					) : showStore ? (
						<StoreSurface installed={apps} onClose={() => setStoreOpen(false)} />
					) : connection === 'ready' || filtered.length > 0 ? (
						<div className="app-grid">
							{filtered.map((app) => (
								<a className="app-cell" href={appUrl(app.id)} key={app.id} title={app.name}>
									<AppIcon app={app} />
									<span className="app-name">{app.name}</span>
								</a>
							))}
							{/* The way in to everything not installed yet — the store is a tile, not a
							    separate app. Hidden while searching, where the grid is a result list. */}
							{text === '' ? (
								<button
									className="app-cell"
									onClick={() => setStoreOpen(true)}
									title="Browse the App Store"
									type="button"
								>
									<img className="app-icon" src={appStoreIcon} alt="" />
									<span className="app-name">App Store</span>
								</button>
							) : null}
						</div>
					) : (
						<div className="empty-state">Connecting to Kodama…</div>
					)}
				</div>
				<form className="composer" onSubmit={submit}>
					<label className="sr-only" htmlFor="launcher-input">
						Search apps or message agent
					</label>
					<input
						id="launcher-input"
						onChange={(event) => setQuery(event.currentTarget.value)}
						onKeyDown={(event) => {
							if (event.key === 'Escape') {
								setChatOpen(false)
								setStoreOpen(false)
								setQuery('')
							}
						}}
						placeholder={showChat ? 'Message agent…' : 'Search apps or message agent…'}
						value={query}
					/>
				</form>
				<div className="status" role="status">
					{status}
				</div>
			</section>
		</main>
	)
}

function ChatSurface({ chat }: { chat: ReturnType<typeof useAgentChat> }) {
	if (chat.messages.length === 0) {
		if (chat.connection === 'connecting') {
			return <div className="empty-state">Connecting to agent…</div>
		}
		if (chat.connection === 'disconnected') {
			return <div className="empty-state">{chat.error ?? 'Agent disconnected'}</div>
		}
	}
	return (
		<div className="chat-surface">
			<Transcript
				messages={chat.messages}
				isStreaming={chat.isStreaming}
				onOption={(label) => void chat.send(label)}
			/>
		</div>
	)
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
	if (app.icon) {
		return (
			<img
				alt=""
				className="app-icon"
				src={app.icon.startsWith('data:') ? app.icon : iconUrl(app.id)}
			/>
		)
	}
	return <span className="app-icon app-glyph">{glyph(app)}</span>
}

function glyph(app: App): string {
	return (app.name.trim() || app.id).slice(0, 1).toUpperCase()
}

function appUrl(id: string): string {
	return `/app/${encodeURIComponent(id)}`
}

function iconUrl(id: string): string {
	return `/app/${encodeURIComponent(id)}/icon`
}

const styles = `
:root {
	color-scheme: dark;
	--surface: #2c2c2e;
	--surface-subtle: #ffffff1a;
	--text: #ebebf0;
	--rule: #3a3a3c;
	--control-bg: #48484a;
	--control-bg-hover: #545458;
	--control-bg-active: #3a3a3c;
	--focus: #0a84ff;
	--on-focus: #ffffff;
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

button.app-cell {
	border: 0;
	padding: 12px 0 0;
	background: transparent;
	font: inherit;
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

.chat-surface {
	height: 100%;
	min-height: 0;
	display: flex;
	color: var(--text);
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
