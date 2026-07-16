import { escalatesCapabilities } from '@justfiles/app/appstore'
import { Transcript } from '@justfiles/ui/Transcript'
import {
	ArrowClockwiseIcon,
	ArrowSquareOutIcon,
	ArrowsOutIcon,
	BellIcon,
	ChatCircleIcon,
	DownloadSimpleIcon,
	MagnifyingGlassIcon,
	SparkleIcon,
	TrashIcon
} from '@phosphor-icons/react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CommunityCatalogApp } from '../../shared/appstore'
import { useAgentConnection, useAgentSession } from '../agent/hooks'
import { Whisper } from '../agent/Whisper'
import {
	useAppCommands,
	useCommunityCatalog,
	useInstalledApps,
	useInstallingApps
} from '../apps/hooks'
import type { InstalledApp } from '../apps/types'
import { useNotifications } from '../notifications/hooks'
import { useDismissTimer } from '../notifications/lifetime'
import { type NotificationEntry, notificationStore, type Route } from '../notifications/store'
import { useAgentClient, useOsDispatch, useOsStore } from '../os/hooks'
import { selectFocusedAppId } from '../os/selectors'
import { AGENT_WINDOW_ID } from '../os/state'
import { ConsentSheet, type ConsentTarget } from './ConsentSheet'
import { MigrationSheet } from './MigrationSheet'

// The omnibar: one intent surface at the bottom of the desktop. You type, and it
// routes — an installed app match launches, anything else asks the agent. The
// input is fixed at the bottom; everything grows upward from it, most-relevant
// nearest the input (see design/01-omnibar.md). This replaces the dock: the app
// grid it shows at rest is where launching now lives.

type Row =
	| { kind: 'app'; app: InstalledApp }
	| { kind: 'store'; app: CommunityCatalogApp }
	| { kind: 'update'; app: CommunityCatalogApp }
	| { kind: 'ask' }

// The sheet is the quick-access view: it renders only the recent tail of the
// transcript, never the whole thing. Older history lives in the conversation
// window — the "no 200-message overlay" rule is enforced here, in the render
// cap, not by spawning a window. Past the cap, an escalating "Open in window"
// invitation appears at the top of the tail (see design/01-omnibar.md).
const SHEET_TAIL = 8

// The first-party Settings app — a `settings` route (e.g. accounts → reconnect)
// opens it, reusing the ordinary `app.open` dispatch.
const SETTINGS_APP_ID = 'computer.spud.settings'

// The one-time "bring your local work into this account" offer rides a `system`
// question on this thread; engaging it opens the migration sheet (handled locally
// below) rather than routing like an ordinary notification.
const MIGRATION_THREAD = 'local-migration'

// The pill action button's label, derived from where a click routes.
function routeLabel(route: Route): string {
	if (route.kind === 'settings') return 'Open Settings'
	if (route.kind === 'app') return 'Open'
	return 'Open chat'
}

// Compact relative time for center rows.
function formatTime(at: number): string {
	const diff = Date.now() - at
	if (diff < 60_000) return 'now'
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
	return `${Math.floor(diff / 86_400_000)}d`
}

function matchesQuery(query: string, ...fields: (string | undefined)[]): boolean {
	const needle = query.toLowerCase()
	if (!needle) return true
	return fields.some((f) => (f ?? '').toLowerCase().includes(needle))
}

function filterApps(apps: InstalledApp[], query: string): InstalledApp[] {
	return apps.filter((app) => matchesQuery(query, app.name, app.id, app.description))
}

function storeIconUrl(app: CommunityCatalogApp): string | undefined {
	return app.icon
		? `https://cdn.jsdelivr.net/npm/${app.npm}@${app.version}/dist/${app.icon}`
		: undefined
}

export function Omnibar({
	onAppMenu,
	onPersonalize
}: {
	// Right-click on an app tile reuses the desktop's shared context menu
	// (Open / Uninstall), so deleting the dock doesn't strand uninstall.
	onAppMenu?: (event: ReactMouseEvent, app: InstalledApp) => void
	onPersonalize: () => void
}) {
	const apps = useInstalledApps()
	const installing = useInstallingApps()
	const catalog = useCommunityCatalog()
	const { launchApp, installCommunity } = useAppCommands()
	const agent = useAgentClient()
	const session = useAgentSession()
	const connection = useAgentConnection()
	const dispatch = useOsDispatch()
	const ready = connection.state === 'ready'

	const [query, setQuery] = useState('')
	const [chatOpen, setChatOpen] = useState(false)
	// Engagement gates the surface: at rest the omnibar is just the pill. Focus
	// (click, ⌘K, or just typing) expands the sheet above it; blur collapses it.
	// A streaming reply keeps the sheet up so an in-flight answer isn't lost.
	const [focused, setFocused] = useState(false)
	// null means "follow the default target"; an arrow/hover pins an explicit row.
	const [pinned, setPinned] = useState<number | null>(null)
	// The dropup's notification-center mode, and a hover flag that pauses the
	// active banner's dismiss timer.
	const [showNotifications, setShowNotifications] = useState(false)
	const [bannerHovered, setBannerHovered] = useState(false)
	const inputRef = useRef<HTMLInputElement>(null)

	const text = query.trim()
	const matches = useMemo(() => filterApps(apps, text), [apps, text])

	// Community discovery (flag-gated; `catalog` is empty when off). Store rows are
	// catalog apps not already installed; held-update rows are installed apps whose
	// catalog version declares MORE access than what's installed (Step 4 held it).
	// Both only appear while searching, alongside the app matches.
	const installedById = useMemo(() => new Map(apps.map((a) => [a.id, a])), [apps])
	const installingById = useMemo(() => new Map(installing.map((a) => [a.id, a])), [installing])
	const storeMatches = useMemo(
		() =>
			text === ''
				? []
				: catalog.filter(
						(a) =>
							!installedById.has(a.id) &&
							!installingById.has(a.id) &&
							matchesQuery(text, a.name, a.id, a.description)
					),
		[catalog, text, installedById, installingById]
	)
	const heldUpdates = useMemo(
		() =>
			text === ''
				? []
				: catalog.filter((a) => {
						const installed = installedById.get(a.id)
						return (
							!!installed &&
							a.version !== installed.version &&
							escalatesCapabilities(installed.capabilities, a.capabilities) &&
							matchesQuery(text, a.name, a.id, a.description)
						)
					}),
		[catalog, text, installedById]
	)
	const [consent, setConsent] = useState<ConsentTarget | null>(null)
	const [migrateOpen, setMigrateOpen] = useState(false)

	// One flat, keyboard-navigable list, laid out visually top→bottom: weaker app
	// matches up top, the best match just above the pinned "Ask Frieren" row, which
	// sits directly above the input as the universal fall-through.
	const rows = useMemo<Row[]>(
		() => [
			...storeMatches.map((app): Row => ({ kind: 'store', app })),
			...heldUpdates.map((app): Row => ({ kind: 'update', app })),
			...matches.map((app): Row => ({ kind: 'app', app })).reverse(),
			{ kind: 'ask' }
		],
		[matches, storeMatches, heldUpdates]
	)
	// Default target: the best app match when something matched, else "Ask Frieren".
	const defaultIndex = matches.length ? rows.length - 2 : rows.length - 1
	const selected = pinned === null ? defaultIndex : Math.min(pinned, rows.length - 1)

	// Coexistence rule: while the conversation window is open, the sheet stays in
	// launcher mode — no duplicated live transcript. The pill still sends to the
	// session; replies land in the window.
	const agentWindowOpen = useOsStore((s) => !!s.windows[AGENT_WINDOW_ID])
	const agentWindowFocused = useOsStore(
		(s) => s.focusStack[s.focusStack.length - 1] === AGENT_WINDOW_ID
	)
	const focusedAppId = useOsStore(selectFocusedAppId)
	const { entries, active, queued, unread } = useNotifications()
	// When the window closes, hand the transcript back to the sheet so the pill
	// stays the way back into the conversation.
	const hadWindow = useRef(agentWindowOpen)
	useEffect(() => {
		if (hadWindow.current && !agentWindowOpen && session.messages.length > 0) setChatOpen(true)
		hadWindow.current = agentWindowOpen
	}, [agentWindowOpen, session.messages.length])
	// spud-mac's fall-through: a query that matches no app means you're talking to
	// the agent, so the sheet slides straight into the transcript instead of a lone
	// "Ask" row. The conversation window preempts it (coexistence rule) — there the
	// row stays and just implies the send lands over in the window.
	const noAppMatch =
		text !== '' && matches.length === 0 && storeMatches.length === 0 && heldUpdates.length === 0
	const expanded =
		focused || showNotifications || (chatOpen && session.isStreaming && !agentWindowOpen)
	const showTranscript = !agentWindowOpen && ((text === '' && chatOpen) || noAppMatch)
	const showList = text !== '' && !showTranscript

	// Cap the sheet to the last few exchanges; the window is where the full
	// history is read.
	const tail = useMemo(() => session.messages.slice(-SHEET_TAIL), [session.messages])
	const truncated = session.messages.length > SHEET_TAIL

	// The center lists everything, newest-first, grouped by source (agent / app).
	const grouped = useMemo(() => {
		const bySource = new Map<string, NotificationEntry[]>()
		for (const entry of [...entries].reverse()) {
			const list = bySource.get(entry.notification.source) ?? []
			list.push(entry)
			bySource.set(entry.notification.source, list)
		}
		return [...bySource.entries()]
	}, [entries])

	// Opening the window is the one explicit hand-off from sheet to durable home:
	// collapse the sheet and hand focus over so replies land in the window.
	const openWindow = () => {
		dispatch({ type: 'agent.openWindow' })
		setChatOpen(false)
		inputRef.current?.blur()
	}

	// The conversation is reachable on demand, not only as a fall-through: the
	// pill's chat button opens the transcript (or focuses the window when it owns
	// the conversation), so a dismissed session is never stranded with no way back.
	const openConversation = () => {
		if (agentWindowOpen) dispatch({ type: 'window.focus', id: AGENT_WINDOW_ID })
		else {
			setChatOpen(true)
			inputRef.current?.focus()
		}
	}

	// A notification click routes through the OS store — the same dispatches the
	// omnibar already uses, so the click resolves in place: chat focuses/opens the
	// conversation, app launches/focuses, settings opens the Settings app.
	const dispatchRoute = (route: Route) => {
		if (route.kind === 'chat') openConversation()
		else if (route.kind === 'app') dispatch({ type: 'app.open', appId: route.id })
		else dispatch({ type: 'app.open', appId: SETTINGS_APP_ID })
	}
	const runNotification = (entry: NotificationEntry) => {
		if (entry.notification.threadId === MIGRATION_THREAD) {
			setMigrateOpen(true)
			notificationStore.dismiss(entry.notification.id)
			return
		}
		if (entry.notification.route) dispatchRoute(entry.notification.route)
		notificationStore.dismiss(entry.notification.id)
	}
	// The pill's action label: the migration offer opens the sheet; everything else
	// routes. Null hides the button (nothing actionable).
	const pillActionLabel = (n: NotificationEntry['notification']): string | null =>
		n.threadId === MIGRATION_THREAD ? 'Bring over' : n.route ? routeLabel(n.route) : null
	// The bell toggles the center; opening it marks history seen (clears the badge)
	// and focuses the input so a blur/Esc collapses it like any other sheet mode.
	const openNotifications = () => {
		const next = !showNotifications
		setShowNotifications(next)
		if (next) {
			notificationStore.markSeen()
			inputRef.current?.focus()
		} else inputRef.current?.blur()
	}

	// Presence and notifications are one model. The pill surfaces the single active
	// notification: its glow carries urgency (`error` an urgent ring, `question` the
	// needs-you pulse), its text slot the title/body, and an action button routes a
	// click. Focus suppresses the banner when its target is already in front (chat
	// focused ⇒ an agent info/question just updates the transcript) — `error` ignores
	// focus. Either way the item still lands in the center.
	const chatInFront = agentWindowFocused || (chatOpen && focused && !agentWindowOpen)
	const targetInFront = (route?: Route): boolean => {
		if (!route) return false
		if (route.kind === 'chat') return chatInFront
		if (route.kind === 'app') return focusedAppId === route.id
		return false
	}
	const suppressed =
		!!active && active.notification.kind !== 'error' && targetInFront(active.notification.route)
	const banner = suppressed ? null : active
	const bannerKind = banner?.notification.kind
	const agentState = session.isStreaming
		? 'working'
		: bannerKind === 'error'
			? 'error'
			: bannerKind === 'question'
				? 'needs-you'
				: 'idle'
	// Who a notification is from: the agent shows its (personalized) name; other
	// sources fall back to the producer-set title.
	const notificationWho = (n: NotificationEntry['notification']): string =>
		n.source === 'agent' ? session.agentName : n.title
	// The text slot only holds the banner while the input is empty + unfocused; the
	// first keystroke/focus hands it back (the shipped placeholder rule).
	const placeholder =
		!focused && banner
			? `${notificationWho(banner.notification)}: ${banner.notification.body}${
					queued > 0 ? ` (+${queued})` : ''
				}`
			: `Search apps, or talk to ${session.agentName}…`

	// Auto-recede `info` after its lifetime; `error`/`question` are sticky. Paused on
	// hover and while the tab is hidden.
	useDismissTimer(active, notificationStore.dismiss, bannerHovered)

	const ask = (prompt: string) => {
		if (!prompt || !ready || session.isStreaming) return
		agent.prompt(prompt)
		setChatOpen(true)
		setQuery('')
	}

	const run = (index: number) => {
		const row = rows[index]
		if (!row) return
		if (row.kind === 'app') {
			launchApp(row.app)
			setQuery('')
			setChatOpen(false)
			inputRef.current?.blur()
		} else if (row.kind === 'store') {
			setConsent({ app: row.app, mode: 'install' })
		} else if (row.kind === 'update') {
			setConsent({ app: row.app, mode: 'update' })
		} else {
			ask(text)
		}
	}

	const submit = (event: React.FormEvent) => {
		event.preventDefault()
		if (text === '') return
		run(selected)
	}

	// Just start typing anywhere on the desktop to focus the bar; ⌘K / ⌘Space
	// summon it over a full-screen app. The bar is the door — the shortcut is only
	// the accelerator.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const summon = (event.metaKey || event.ctrlKey) && (event.key === 'k' || event.key === ' ')
			if (summon) {
				event.preventDefault()
				inputRef.current?.focus()
				return
			}
			if (event.metaKey || event.ctrlKey || event.altKey) return
			if (event.key.length !== 1) return
			const target = event.target as HTMLElement | null
			const tag = target?.tagName
			if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return
			inputRef.current?.focus()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [])

	const onKeyDown = (event: React.KeyboardEvent) => {
		if (event.key === 'Escape') {
			if (showNotifications) setShowNotifications(false)
			else if (text !== '') setQuery('')
			else if (chatOpen) setChatOpen(false)
			else inputRef.current?.blur()
			return
		}
		if (text === '') return
		if (event.key === 'ArrowUp') {
			event.preventDefault()
			setPinned(Math.max(0, selected - 1))
		} else if (event.key === 'ArrowDown') {
			event.preventDefault()
			setPinned(Math.min(rows.length - 1, selected + 1))
		}
	}

	return (
		/* biome-ignore lint/a11y/noStaticElementInteractions: hover pauses the active
		   banner's dismiss timer (dunst pause_on_mouse_over); the pill is an ambient
		   container, not itself a control. */
		<div
			className="frn-omnibar"
			data-expanded={expanded}
			data-agent={agentState}
			onMouseEnter={() => setBannerHovered(true)}
			onMouseLeave={() => setBannerHovered(false)}
		>
			{expanded ? (
				/* biome-ignore lint/a11y/noStaticElementInteractions: mousedown-preventDefault keeps
				   focus in the input so surface clicks don't collapse the sheet mid-click. Inline
				   text selection is sacrificed; expand-to-window is the copy escape hatch. */
				<div className="frn-omnibar-surface" onMouseDown={(event) => event.preventDefault()}>
					{showNotifications ? (
						<div className="frn-omnibar-center">
							<div className="frn-omnibar-center-head">
								<span>Notifications</span>
								{entries.length > 0 ? (
									<button
										type="button"
										className="frn-omnibar-center-clear"
										onClick={() => notificationStore.clear()}
									>
										<TrashIcon /> Clear
									</button>
								) : null}
							</div>
							{entries.length === 0 ? (
								<p className="frn-omnibar-center-empty">Nothing here yet.</p>
							) : (
								<ul className="frn-omnibar-center-list">
									{grouped.map(([source, items]) => (
										<Fragment key={source}>
											<li className="frn-omnibar-section">
												{items[0] ? notificationWho(items[0].notification) : source}
											</li>
											{items.map((entry) => (
												<li key={entry.notification.id}>
													<button
														type="button"
														className="frn-omnibar-center-row"
														data-kind={entry.notification.kind}
														onClick={() => runNotification(entry)}
													>
														<span className="frn-omnibar-center-body">
															{entry.notification.body}
														</span>
														<span className="frn-omnibar-center-time">{formatTime(entry.at)}</span>
													</button>
												</li>
											))}
										</Fragment>
									))}
								</ul>
							)}
						</div>
					) : showTranscript ? (
						<div className="frn-omnibar-chat">
							<div className="frn-omnibar-chat-head">
								<button
									type="button"
									className="frn-omnibar-chat-identity"
									title="Personalize"
									onClick={onPersonalize}
								>
									<img
										src={session.avatarUrl}
										alt=""
										className="frn-agent-avatar"
										data-personalized={session.personalized}
									/>
									<span>{session.agentName}</span>
								</button>
								<button
									type="button"
									className="frn-omnibar-expand"
									title="Expand conversation"
									aria-label="Expand conversation"
									onClick={openWindow}
								>
									<ArrowsOutIcon />
								</button>
							</div>
							<Transcript
								messages={tail}
								isStreaming={session.isStreaming}
								onOption={(label) => ask(label)}
								leading={
									truncated ? (
										<button type="button" className="frn-omnibar-tail-more" onClick={openWindow}>
											Earlier messages · Open in window <ArrowsOutIcon />
										</button>
									) : undefined
								}
							/>
							{session.personalized ? null : <Whisper onPersonalize={onPersonalize} />}
						</div>
					) : showList ? (
						<ul className="frn-omnibar-list">
							{rows.map((row, index) => {
								const isSelected = index === selected
								if (row.kind === 'app') {
									const startsSection = rows[index - 1]?.kind !== 'app'
									return (
										<Fragment key={row.app.id}>
											{startsSection ? (
												<li className="frn-omnibar-section">On this computer</li>
											) : null}
											<li>
												<button
													type="button"
													className="frn-omnibar-row"
													data-selected={isSelected}
													onMouseMove={() => setPinned(index)}
													onClick={() => run(index)}
												>
													<span className="frn-omnibar-icon frn-omnibar-icon-sm">
														{row.app.iconUrl ? (
															<img src={row.app.iconUrl} alt="" />
														) : (
															row.app.name.slice(0, 1).toUpperCase()
														)}
													</span>
													<span className="frn-omnibar-row-copy">
														<span className="frn-omnibar-row-label">{row.app.name}</span>
														{row.app.description ? (
															<span className="frn-omnibar-row-description">
																{row.app.description}
															</span>
														) : null}
													</span>
												</button>
											</li>
										</Fragment>
									)
								}
								if (row.kind === 'store' || row.kind === 'update') {
									const isUpdate = row.kind === 'update'
									const icon = storeIconUrl(row.app)
									const startsSection = rows[index - 1]?.kind !== row.kind
									return (
										<Fragment key={`${row.kind}:${row.app.id}`}>
											{startsSection ? (
												<li className="frn-omnibar-section">
													{isUpdate ? 'Updates from the App Store' : 'App Store · Not installed'}
												</li>
											) : null}
											<li>
												<button
													type="button"
													className="frn-omnibar-row"
													data-selected={isSelected}
													onMouseMove={() => setPinned(index)}
													onClick={() => run(index)}
												>
													<span className="frn-omnibar-icon frn-omnibar-icon-sm">
														{icon ? (
															<img src={icon} alt="" />
														) : isUpdate ? (
															<ArrowClockwiseIcon />
														) : (
															<DownloadSimpleIcon />
														)}
													</span>
													<span className="frn-omnibar-row-copy">
														<span className="frn-omnibar-row-label">{row.app.name}</span>
														<span className="frn-omnibar-row-description">
															{row.app.description || 'No description provided by the publisher.'}
														</span>
													</span>
													<span className="frn-omnibar-row-hint" data-action="true">
														{isUpdate ? 'Review update' : 'Install'}
													</span>
												</button>
											</li>
										</Fragment>
									)
								}
								return (
									<li key="ask" data-divider={rows.length > 1}>
										<button
											type="button"
											className="frn-omnibar-row"
											data-selected={isSelected}
											onMouseMove={() => setPinned(index)}
											onClick={() => run(index)}
										>
											<span className="frn-omnibar-icon frn-omnibar-icon-sm">
												<SparkleIcon />
											</span>
											<span className="frn-omnibar-row-label">
												Ask {session.agentName}: <em>“{text}”</em>
											</span>
											{agentWindowOpen ? (
												<span className="frn-omnibar-row-hint">
													in conversation <ArrowsOutIcon />
												</span>
											) : null}
										</button>
									</li>
								)
							})}
						</ul>
					) : apps.length > 0 || installing.length > 0 ? (
						<div className="frn-omnibar-grid">
							{apps.map((app) => (
								<button
									key={app.id}
									type="button"
									className="frn-omnibar-tile"
									title={app.description || app.name}
									onClick={() => {
										launchApp(app)
										inputRef.current?.blur()
									}}
									onContextMenu={onAppMenu ? (event) => onAppMenu(event, app) : undefined}
								>
									<span className="frn-omnibar-icon">
										{app.iconUrl ? (
											<img src={app.iconUrl} alt="" />
										) : (
											app.name.slice(0, 1).toUpperCase()
										)}
									</span>
									<span className="frn-omnibar-tile-name">{app.name}</span>
								</button>
							))}
							{installing
								.filter((app) => !installedById.has(app.id))
								.map((app) => (
									<div
										key={`installing:${app.id}`}
										className="frn-omnibar-tile"
										data-installing="true"
										title={`Installing ${app.name}…`}
									>
										<span className="frn-omnibar-icon">
											{app.iconUrl ? (
												<img src={app.iconUrl} alt="" />
											) : (
												app.name.slice(0, 1).toUpperCase()
											)}
											<span className="frn-omnibar-tile-spinner" />
										</span>
										<span className="frn-omnibar-tile-name">{app.name}</span>
									</div>
								))}
						</div>
					) : null}
				</div>
			) : null}
			<form className="frn-omnibar-bar" onSubmit={submit}>
				<MagnifyingGlassIcon className="frn-omnibar-search" />
				<input
					ref={inputRef}
					value={query}
					onChange={(event) => {
						setQuery(event.currentTarget.value)
						setPinned(null)
						setShowNotifications(false)
					}}
					onFocus={() => {
						setFocused(true)
						// Engaging while the agent waits on a question lands on the
						// question: in the window if it's open, else the sheet transcript. The
						// migration offer is a `system` question with its own sheet, not chat.
						if (
							active?.notification.kind === 'question' &&
							active.notification.threadId !== MIGRATION_THREAD
						) {
							if (agentWindowOpen) dispatch({ type: 'window.focus', id: AGENT_WINDOW_ID })
							else setChatOpen(true)
						}
					}}
					onBlur={() => {
						setFocused(false)
						setShowNotifications(false)
					}}
					onKeyDown={onKeyDown}
					placeholder={placeholder}
					aria-label="Search apps or talk to Frieren"
					autoComplete="off"
					spellCheck={false}
				/>
				{!focused && banner && pillActionLabel(banner.notification) ? (
					/* The banner's action button, on the pill's right edge: a click runs the
					   route dispatch (or opens the migration sheet) and recedes the item. */
					<button
						type="button"
						className="frn-omnibar-action"
						title={pillActionLabel(banner.notification) ?? undefined}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => runNotification(banner)}
					>
						<ArrowSquareOutIcon />
						<span>{pillActionLabel(banner.notification)}</span>
					</button>
				) : null}
				{unread > 0 || showNotifications ? (
					/* Contextual bell-badge: appears when there's unread history, opens the
					   center. mousedown-preventDefault keeps focus so the toggle is stable. */
					<button
						type="button"
						className="frn-omnibar-bell"
						data-open={showNotifications}
						title="Notifications"
						aria-label="Notifications"
						onMouseDown={(event) => event.preventDefault()}
						onClick={openNotifications}
					>
						<BellIcon />
						{unread > 0 ? <span className="frn-omnibar-bell-badge">{unread}</span> : null}
					</button>
				) : null}
				{session.messages.length > 0 ? (
					/* Discoverable way back into the conversation — mousedown-preventDefault
					   keeps the input focused so the click doesn't collapse the sheet. */
					<button
						type="button"
						className="frn-omnibar-chat-toggle"
						title={`Open conversation with ${session.agentName}`}
						aria-label="Open conversation"
						onMouseDown={(event) => event.preventDefault()}
						onClick={openConversation}
					>
						<ChatCircleIcon />
					</button>
				) : null}
			</form>
			{consent
				? createPortal(
						<ConsentSheet
							target={consent}
							onConfirm={() => installCommunity(consent.app)}
							onClose={() => setConsent(null)}
						/>,
						document.body
					)
				: null}
			{migrateOpen
				? createPortal(<MigrationSheet onClose={() => setMigrateOpen(false)} />, document.body)
				: null}
		</div>
	)
}
