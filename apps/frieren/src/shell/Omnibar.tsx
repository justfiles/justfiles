import { escalatesCapabilities } from '@justfiles/app/appstore'
import { Transcript } from '@justfiles/ui/Transcript'
import {
	ArrowClockwiseIcon,
	ArrowSquareOutIcon,
	ArrowsOutIcon,
	BellIcon,
	ChatCircleIcon,
	DownloadSimpleIcon,
	SparkleIcon,
	StorefrontIcon,
	TrashIcon
} from '@phosphor-icons/react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CommunityCatalogApp } from '../../shared/appstore'
import { useAgentConnection, useAgentSession } from '../agent/hooks'
import { resolveTranscriptImage } from '../agent/images'
import { Whisper } from '../agent/Whisper'
import {
	useAppCommands,
	useCommunityCatalog,
	useInstalledApps,
	useInstallingApps
} from '../apps/hooks'
import type { InstalledApp } from '../apps/types'
import { useAutoResize } from '../components/useAutoResize'
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

// The composer grows with wrapped input like iMessage, then scrolls once it
// hits ~5 lines so a pasted wall of text can't shove the sheet open (5 × 20px
// line-height + 14px vertical padding).
const MAX_INPUT_HEIGHT = 114

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
const SETTINGS_APP_ID = 'app.justfiles.frieren.settings'

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

// Which *visual* line the caret sits on. Result-navigation arrows only fire at
// the top/bottom edge so a wrapped draft (soft wrap or an explicit Shift+Enter
// newline) stays vertically editable; a single visual line counts as both first
// and last, so short queries still navigate on the first press. A hidden mirror
// reproduces the textarea's wrapping to locate the caret's row.
function caretVisualEdge(
	el: HTMLTextAreaElement,
	caret: number
): { first: boolean; last: boolean } {
	const cs = getComputedStyle(el)
	const mirror = document.createElement('div')
	const ms = mirror.style
	ms.position = 'absolute'
	ms.left = '-9999px'
	ms.top = '0'
	ms.visibility = 'hidden'
	ms.whiteSpace = 'pre-wrap'
	ms.overflowWrap = 'break-word'
	ms.boxSizing = 'border-box'
	ms.width = `${el.clientWidth}px`
	for (const p of [
		'fontFamily',
		'fontSize',
		'fontWeight',
		'fontStyle',
		'letterSpacing',
		'lineHeight',
		'textIndent',
		'textTransform',
		'wordSpacing',
		'paddingLeft',
		'paddingRight',
		'paddingTop',
		'paddingBottom'
	] as const) {
		ms[p] = cs[p]
	}
	const value = el.value
	mirror.textContent = value.slice(0, caret)
	const marker = document.createElement('span')
	// The rest of the text starts exactly at the caret, so the marker's top is the
	// caret's row; a fallback glyph gives the last (empty) position a line box.
	marker.textContent = value.slice(caret) || '.'
	mirror.appendChild(marker)
	document.body.appendChild(mirror)
	const lineHeight = Number.parseFloat(cs.lineHeight) || Number.parseFloat(cs.fontSize) * 1.2
	const padTop = Number.parseFloat(cs.paddingTop) || 0
	const padBottom = Number.parseFloat(cs.paddingBottom) || 0
	const caretTop = marker.offsetTop - padTop
	const contentHeight = mirror.scrollHeight - padTop - padBottom
	mirror.remove()
	// Half-line thresholds absorb sub-pixel rounding without spilling into a
	// neighbouring row.
	return {
		first: caretTop < lineHeight * 0.5,
		last: caretTop > contentHeight - lineHeight * 1.5
	}
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
	// Store-browse mode: the empty-focused grid's "App Store" tile flips the sheet
	// into a discovery list of not-installed catalog apps — this is where "browse
	// all apps" lives (design/01-omnibar.md open question). Transient like the rest
	// of the sheet: blur, Esc, or typing a query leaves it.
	const [browseStore, setBrowseStore] = useState(false)
	const inputRef = useRef<HTMLTextAreaElement>(null)

	const text = query.trim()
	const matches = useMemo(() => filterApps(apps, text), [apps, text])
	useAutoResize(inputRef, query, MAX_INPUT_HEIGHT)

	// Community discovery (flag-gated; `catalog` is empty when off). Store rows are
	// catalog apps not already installed; held-update rows are installed apps whose
	// catalog version declares MORE access than what's installed (Step 4 held it).
	// Both only appear while searching, alongside the app matches.
	const installedById = useMemo(() => new Map(apps.map((a) => [a.id, a])), [apps])
	const installingById = useMemo(() => new Map(installing.map((a) => [a.id, a])), [installing])
	// Catalog apps not already installed/installing — the discovery candidates,
	// shared by the store tile's visibility and browse mode's list.
	const storeCandidates = useMemo(
		() => catalog.filter((a) => !installedById.has(a.id) && !installingById.has(a.id)),
		[catalog, installedById, installingById]
	)
	// Browse holds while the input is empty; the list shows the not-installed
	// catalog apps (or an all-installed empty state). The tile stays discoverable in
	// the grid regardless, so the store is reachable even after installing them all.
	const browsing = browseStore && text === ''
	const storeMatches = useMemo(
		() =>
			text === '' && !browsing
				? []
				: storeCandidates.filter((a) => matchesQuery(text, a.name, a.id, a.description)),
		[storeCandidates, text, browsing]
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
		() =>
			browsing
				? storeMatches.map((app): Row => ({ kind: 'store', app }))
				: [
						...storeMatches.map((app): Row => ({ kind: 'store', app })),
						...heldUpdates.map((app): Row => ({ kind: 'update', app })),
						...matches.map((app): Row => ({ kind: 'app', app })).reverse(),
						{ kind: 'ask' }
					],
		[matches, storeMatches, heldUpdates, browsing]
	)
	// Default target: in browse mode the bottom row (nearest the input); otherwise
	// the best app match when something matched, else "Ask Frieren".
	const defaultIndex = browsing
		? Math.max(0, rows.length - 1)
		: matches.length
			? rows.length - 2
			: rows.length - 1
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
	const showList = (text !== '' || browsing) && !showTranscript

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
		if (text === '' && !browsing) return
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

	const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === 'Escape') {
			if (showNotifications) setShowNotifications(false)
			else if (browseStore) setBrowseStore(false)
			else if (text !== '') setQuery('')
			else if (chatOpen) setChatOpen(false)
			else inputRef.current?.blur()
			return
		}
		// While an IME composition is active, Enter confirms the candidate and the
		// arrows move within it — leave those to the composer, don't submit/navigate.
		if (event.nativeEvent.isComposing) return
		// Enter sends/launches; Shift+Enter drops a newline (the textarea grows).
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault()
			if (text === '' && !browsing) return
			run(selected)
			return
		}
		if (text === '' && !browsing) return
		// Arrows navigate results, but only at the caret's top/bottom visual line so a
		// wrapped multiline query stays editable vertically.
		const el = event.currentTarget
		if (event.key === 'ArrowUp') {
			if (!caretVisualEdge(el, el.selectionStart).first) return
			event.preventDefault()
			setPinned(Math.max(0, selected - 1))
		} else if (event.key === 'ArrowDown') {
			if (!caretVisualEdge(el, el.selectionEnd).last) return
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
								resolveImage={resolveTranscriptImage}
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
							{browsing && rows.length === 0 ? (
								<li className="frn-omnibar-center-empty">You've installed every App Store app.</li>
							) : null}
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
					) : apps.length > 0 || installing.length > 0 || catalog.length > 0 ? (
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
							{catalog.length > 0 ? (
								<button
									type="button"
									className="frn-omnibar-tile"
									data-store="true"
									title="Browse the App Store"
									onClick={() => setBrowseStore(true)}
								>
									<span className="frn-omnibar-icon">
										<StorefrontIcon />
									</span>
									<span className="frn-omnibar-tile-name">App Store</span>
								</button>
							) : null}
						</div>
					) : null}
				</div>
			) : null}
			<form className="frn-omnibar-bar" onSubmit={submit}>
				<textarea
					ref={inputRef}
					rows={1}
					value={query}
					onChange={(event) => {
						setQuery(event.currentTarget.value)
						setPinned(null)
						setShowNotifications(false)
						setBrowseStore(false)
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
						setBrowseStore(false)
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
