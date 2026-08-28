import { escalatesCapabilities, semverGte } from '@justfiles/app/appstore'
import {
	ArrowClockwiseIcon,
	ArrowSquareOutIcon,
	BellIcon,
	DownloadSimpleIcon,
	MagnifyingGlassIcon,
	TrashIcon
} from '@phosphor-icons/react'
import type {
	CSSProperties,
	FormEvent,
	KeyboardEvent as ReactKeyboardEvent,
	MouseEvent as ReactMouseEvent
} from 'react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import appStoreIcon from '../../../../packages/design/assets/app_store.svg'
import type { RunnerCatalogApp } from '../../../shared/justapps'
import { AgentAvatar } from '../agent/AgentAvatar'
import { useAgentConnection, useAgentSession } from '../agent/hooks'
import {
	useAppCommands,
	useInstalledApps,
	useInstallingApps,
	useRunnerCatalog
} from '../apps/hooks'
import type { InstalledApp } from '../apps/types'
import { useNotifications } from '../notifications/hooks'
import { useDismissTimer } from '../notifications/lifetime'
import { type NotificationEntry, notificationStore, type Route } from '../notifications/store'
import { useAgentClient, useOsDispatch, useOsStore } from '../os/hooks'
import { selectFocusedAppId } from '../os/selectors'
import { ConsentSheet, type ConsentTarget } from './ConsentSheet'
import { MigrationSheet } from './MigrationSheet'

const SETTINGS_APP_ID = 'justfiles.settings'
const MIGRATION_THREAD = 'local-migration'
const APP_UPDATES_THREAD = 'held-app-updates'
const DOCK_FIXED_WIDTH = 213
const DOCK_APP_STEP = 52

type Row =
	| { kind: 'app'; app: InstalledApp }
	| { kind: 'store'; app: RunnerCatalogApp }
	| { kind: 'update'; app: RunnerCatalogApp }
	| { kind: 'ask' }

function matchesQuery(query: string, ...fields: (string | undefined)[]): boolean {
	const needle = query.toLowerCase()
	return fields.some((field) => (field ?? '').toLowerCase().includes(needle))
}

function sameIds(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((id, index) => id === b[index])
}

function rankApps(apps: InstalledApp[], recentIds: string[]): InstalledApp[] {
	const rank = new Map(recentIds.map((id, index) => [id, index]))
	return [...apps].sort((a, b) => (rank.get(b.id) ?? -1) - (rank.get(a.id) ?? -1))
}

function routeLabel(route: Route): string {
	if (route.kind === 'settings') return 'Open Settings'
	if (route.kind === 'app') return 'Open'
	return 'Open chat'
}

function formatTime(at: number): string {
	const diff = Date.now() - at
	if (diff < 60_000) return 'now'
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
	return `${Math.floor(diff / 86_400_000)}d`
}

function AppIcon({ app, className = 'frn-dock-icon' }: { app: InstalledApp; className?: string }) {
	return (
		<span className={className}>
			{app.iconUrl ? <img src={app.iconUrl} alt="" /> : app.name.slice(0, 1).toUpperCase()}
		</span>
	)
}

export function Omnibar({
	chatOpen,
	onOpenChat,
	onAppMenu
}: {
	chatOpen: boolean
	onOpenChat: () => void
	onAppMenu?: (event: ReactMouseEvent, app: InstalledApp) => void
}) {
	const apps = useInstalledApps()
	const installing = useInstallingApps()
	const { launchApp, installRunner } = useAppCommands()
	const agent = useAgentClient()
	const session = useAgentSession()
	const connection = useAgentConnection()
	const dispatch = useOsDispatch()
	const ready = connection.state === 'ready'

	const [query, setQuery] = useState('')
	const [focused, setFocused] = useState(false)
	const [pinned, setPinned] = useState<number | null>(null)
	const [showNotifications, setShowNotifications] = useState(false)
	const [bannerHovered, setBannerHovered] = useState(false)
	const [browseStore, setBrowseStore] = useState(false)
	const [consent, setConsent] = useState<ConsentTarget | null>(null)
	const [migrateOpen, setMigrateOpen] = useState(false)
	const [rowCount, setRowCount] = useState(1)
	// Hold one ranked snapshot while the sheet is open so the grid cannot move under the pointer.
	const [gridApps, setGridApps] = useState<InstalledApp[]>([])
	const dockRef = useRef<HTMLDivElement>(null)
	const inputRef = useRef<HTMLInputElement>(null)

	const text = query.trim()
	const matches = useMemo(
		() => apps.filter((app) => matchesQuery(text, app.name, app.id, app.description)),
		[apps, text]
	)
	// Held updates need a resting-state banner, so the dock loads the catalog at rest.
	const { apps: catalog, loading: catalogLoading } = useRunnerCatalog(true)
	const installedById = useMemo(() => new Map(apps.map((app) => [app.id, app])), [apps])
	const installingById = useMemo(
		() => new Map(installing.map((app) => [app.id, app])),
		[installing]
	)
	const storeCandidates = useMemo(
		() => catalog.filter((app) => !installedById.has(app.id) && !installingById.has(app.id)),
		[catalog, installedById, installingById]
	)
	const held = useMemo(
		() =>
			catalog.filter((app) => {
				const installed = installedById.get(app.id)
				if (!installed) return false
				const version = installed.version ?? '0.0.0'
				return (
					app.version !== version &&
					semverGte(app.version, version) &&
					escalatesCapabilities(installed.capabilities, app.capabilities)
				)
			}),
		[catalog, installedById]
	)
	const heldCount = held.length
	const browsing = browseStore && text === ''
	const storeMatches = useMemo(
		() =>
			text === '' && !browsing
				? []
				: storeCandidates.filter((app) => matchesQuery(text, app.name, app.id, app.description)),
		[storeCandidates, text, browsing]
	)
	const heldUpdates = useMemo(
		() =>
			text === ''
				? []
				: held.filter((app) => matchesQuery(text, app.name, app.id, app.description)),
		[held, text]
	)

	const rows = useMemo<Row[]>(
		() =>
			browsing
				? [
						...held.map((app): Row => ({ kind: 'update', app })),
						...storeMatches.map((app): Row => ({ kind: 'store', app }))
					]
				: [
						...storeMatches.map((app): Row => ({ kind: 'store', app })),
						...heldUpdates.map((app): Row => ({ kind: 'update', app })),
						...matches.map((app): Row => ({ kind: 'app', app })).reverse(),
						{ kind: 'ask' }
					],
		[matches, storeMatches, held, heldUpdates, browsing]
	)
	const defaultIndex = browsing
		? Math.max(0, rows.length - 1)
		: matches.length
			? rows.length - 2
			: rows.length - 1
	const selected = pinned === null ? defaultIndex : Math.min(pinned, rows.length - 1)

	const activeIds = useOsStore(
		(state) =>
			state.focusStack.flatMap((id) => {
				const appId = state.windows[id]?.appId
				return appId ? [appId] : []
			}),
		sameIds
	)
	const [recentIds, setRecentIds] = useState(activeIds)
	const runningIds = useOsStore(
		(state) =>
			state.openOrder.flatMap((id) => {
				const appId = state.windows[id]?.appId
				return appId ? [appId] : []
			}),
		sameIds
	)
	const running = useMemo(() => new Set(runningIds), [runningIds])
	const focusedAppId = useOsStore(selectFocusedAppId)
	const { entries, active, queued, unread } = useNotifications()
	const expanded = focused || showNotifications
	const showList = text !== '' || browsing
	const rowApps = apps.slice(0, rowCount)
	const shownInstalling = installing.filter((app) => !installedById.has(app.id))

	const grouped = useMemo(() => {
		const bySource = new Map<string, NotificationEntry[]>()
		for (const entry of [...entries].reverse()) {
			const list = bySource.get(entry.notification.source) ?? []
			list.push(entry)
			bySource.set(entry.notification.source, list)
		}
		return [...bySource.entries()]
	}, [entries])

	useEffect(() => {
		setRecentIds((current) => {
			const active = new Set(activeIds)
			const next = [...current.filter((id) => !active.has(id)), ...activeIds]
			return sameIds(current, next) ? current : next
		})
	}, [activeIds])

	useEffect(() => {
		const desktop = dockRef.current?.parentElement
		if (!desktop) return
		const resize = () => {
			const available = desktop.clientWidth * 0.7
			setRowCount(
				Math.min(10, Math.max(1, Math.floor((available - DOCK_FIXED_WIDTH) / DOCK_APP_STEP)))
			)
		}
		resize()
		const observer = new ResizeObserver(resize)
		observer.observe(desktop)
		return () => observer.disconnect()
	}, [])

	useEffect(() => {
		if (catalogLoading) return
		if (heldCount === 0) {
			notificationStore.dismiss(APP_UPDATES_THREAD)
			return
		}
		notificationStore.notify({
			id: APP_UPDATES_THREAD,
			source: 'system',
			kind: 'info',
			threadId: APP_UPDATES_THREAD,
			title: 'App Store',
			body:
				heldCount === 1
					? '1 app update needs your review.'
					: `${heldCount} app updates need your review.`
		})
	}, [catalogLoading, heldCount])

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const summon = (event.metaKey || event.ctrlKey) && (event.key === 'k' || event.key === ' ')
			if (summon) {
				event.preventDefault()
				inputRef.current?.focus()
				return
			}
			if (event.metaKey || event.ctrlKey || event.altKey || event.key.length !== 1) return
			const target = event.target as HTMLElement | null
			const tag = target?.tagName
			if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return
			inputRef.current?.focus()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [])

	useDismissTimer(active, notificationStore.dismiss, bannerHovered)

	const collapse = () => {
		setQuery('')
		setFocused(false)
		setPinned(null)
		setShowNotifications(false)
		setBrowseStore(false)
		inputRef.current?.blur()
	}
	const openConversation = () => {
		collapse()
		onOpenChat()
	}
	const openStore = () => {
		setShowNotifications(false)
		setBrowseStore(true)
		inputRef.current?.focus()
	}
	const dispatchRoute = (route: Route) => {
		if (route.kind === 'chat') openConversation()
		else if (route.kind === 'app') dispatch({ type: 'app.open', appId: route.id })
		else dispatch({ type: 'app.open', appId: SETTINGS_APP_ID })
	}
	const runNotification = (entry: NotificationEntry) => {
		if (entry.notification.threadId === MIGRATION_THREAD) {
			setMigrateOpen(true)
		} else if (entry.notification.threadId === APP_UPDATES_THREAD) {
			openStore()
		} else if (entry.notification.route) {
			dispatchRoute(entry.notification.route)
		}
		notificationStore.dismiss(entry.notification.id)
	}
	const notificationAction = (entry: NotificationEntry): string | null => {
		if (entry.notification.threadId === MIGRATION_THREAD) return 'Bring over'
		if (entry.notification.threadId === APP_UPDATES_THREAD) return 'Review'
		return entry.notification.route ? routeLabel(entry.notification.route) : null
	}
	const openNotifications = () => {
		const next = !showNotifications
		setShowNotifications(next)
		if (next) {
			notificationStore.markSeen()
			inputRef.current?.focus()
		} else {
			inputRef.current?.blur()
		}
	}

	const targetInFront = (route?: Route): boolean => {
		if (!route) return false
		if (route.kind === 'chat') return chatOpen
		if (route.kind === 'app') return focusedAppId === route.id
		return false
	}
	const suppressed =
		!!active && active.notification.kind !== 'error' && targetInFront(active.notification.route)
	const banner = suppressed || expanded ? null : active
	const bannerKind = active?.notification.kind
	const agentState = session.isStreaming
		? 'working'
		: bannerKind === 'error'
			? 'error'
			: bannerKind === 'question'
				? 'needs-you'
				: 'idle'
	const notificationWho = (entry: NotificationEntry): string =>
		entry.notification.source === 'agent' ? session.agentName : entry.notification.title
	const bannerAction = banner ? notificationAction(banner) : null

	const ask = (prompt: string) => {
		if (!prompt || !ready) return
		void agent.prompt(prompt).then((accepted) => {
			if (!accepted) return
			openConversation()
		})
	}
	const run = (index: number) => {
		const row = rows[index]
		if (!row || (catalogLoading && row.kind === 'ask')) return
		if (row.kind === 'app') {
			launchApp(row.app)
			collapse()
		} else if (row.kind === 'store') {
			setConsent({ app: row.app, mode: 'install' })
		} else if (row.kind === 'update') {
			setConsent({ app: row.app, mode: 'update' })
		} else {
			ask(text)
		}
	}
	const submit = (event: FormEvent) => {
		event.preventDefault()
		if (text === '' && !browsing) return
		run(selected)
	}
	const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
		if (event.key === 'Escape') {
			if (showNotifications) setShowNotifications(false)
			else if (browseStore) setBrowseStore(false)
			else if (text !== '') setQuery('')
			else inputRef.current?.blur()
			return
		}
		if (event.nativeEvent.isComposing) return
		if (event.key === 'Enter') {
			event.preventDefault()
			if (text !== '' || browsing) run(selected)
			return
		}
		if (text === '' && !browsing) return
		if (event.key === 'ArrowUp') {
			event.preventDefault()
			setPinned(Math.max(0, selected - 1))
		} else if (event.key === 'ArrowDown') {
			event.preventDefault()
			setPinned(Math.min(rows.length - 1, selected + 1))
		}
	}

	const rootStyle = {
		'--frn-dock-width': `${DOCK_FIXED_WIDTH + rowApps.length * DOCK_APP_STEP}px`
	} as CSSProperties

	return (
		/* biome-ignore lint/a11y/noStaticElementInteractions: hover pauses an ambient banner's timer. */
		<div
			ref={dockRef}
			className="frn-dock"
			data-expanded={expanded}
			style={rootStyle}
			onMouseEnter={() => setBannerHovered(true)}
			onMouseLeave={() => setBannerHovered(false)}
		>
			{banner ? (
				<div
					className="frn-dock-banner"
					data-kind={banner.notification.kind}
					role={banner.notification.kind === 'error' ? 'alert' : 'status'}
				>
					<AgentAvatar
						url={session.avatarUrl}
						faces={session.avatarFaces}
						expression={session.expression}
						streaming={session.isStreaming}
						personalized={session.personalized}
						size={22}
					/>
					<span className="frn-dock-banner-copy">
						<strong>{notificationWho(banner)}</strong>
						<span>
							{' · '}
							{banner.notification.body}
							{queued > 0 ? ` (+${queued})` : ''}
						</span>
					</span>
					{bannerAction ? (
						<button
							type="button"
							className="frn-dock-banner-action"
							onClick={() => runNotification(banner)}
						>
							<ArrowSquareOutIcon />
							{bannerAction}
						</button>
					) : null}
				</div>
			) : null}

			{expanded ? (
				/* biome-ignore lint/a11y/noStaticElementInteractions: keep the field focused while a sheet control handles the click. */
				<div className="frn-dock-sheet" onMouseDown={(event) => event.preventDefault()}>
					{showNotifications ? (
						<div className="frn-dock-center">
							<div className="frn-dock-center-head">
								<span>Notifications</span>
								{entries.length > 0 ? (
									<button type="button" onClick={() => notificationStore.clear()}>
										<TrashIcon /> Clear
									</button>
								) : null}
							</div>
							{entries.length === 0 ? (
								<p className="frn-dock-empty">Nothing here yet.</p>
							) : (
								<ul className="frn-dock-center-list">
									{grouped.map(([source, items]) => (
										<Fragment key={source}>
											<li className="frn-dock-section">
												{items[0] ? notificationWho(items[0]) : source}
											</li>
											{items.map((entry) => (
												<li key={entry.notification.id}>
													<button
														type="button"
														className="frn-dock-center-row"
														data-kind={entry.notification.kind}
														onClick={() => runNotification(entry)}
													>
														<span>{entry.notification.body}</span>
														<time>{formatTime(entry.at)}</time>
													</button>
												</li>
											))}
										</Fragment>
									))}
								</ul>
							)}
						</div>
					) : showList ? (
						<ul className="frn-dock-list">
							{browsing && rows.length === 0 ? (
								<li className="frn-dock-empty">
									{catalogLoading ? 'Loading App Store…' : "You've installed every App Store app."}
								</li>
							) : null}
							{rows.map((row, index) => {
								const isSelected = index === selected
								if (row.kind === 'app') {
									const startsSection = rows[index - 1]?.kind !== 'app'
									return (
										<Fragment key={row.app.id}>
											{startsSection ? (
												<li className="frn-dock-section">On this computer</li>
											) : null}
											<li>
												<button
													type="button"
													className="frn-dock-row"
													data-selected={isSelected}
													onMouseMove={() => setPinned(index)}
													onClick={() => run(index)}
												>
													<AppIcon app={row.app} className="frn-dock-icon frn-dock-icon-small" />
													<span className="frn-dock-row-copy">
														<span>{row.app.name}</span>
														{row.app.description ? <small>{row.app.description}</small> : null}
													</span>
													<span className="frn-dock-row-hint">↩ open</span>
												</button>
											</li>
										</Fragment>
									)
								}
								if (row.kind === 'store' || row.kind === 'update') {
									const isUpdate = row.kind === 'update'
									const startsSection = rows[index - 1]?.kind !== row.kind
									return (
										<Fragment key={`${row.kind}:${row.app.id}`}>
											{startsSection ? (
												<li className="frn-dock-section">
													{isUpdate ? 'Updates from the App Store' : 'App Store · Not installed'}
												</li>
											) : null}
											<li>
												<button
													type="button"
													className="frn-dock-row"
													data-selected={isSelected}
													onMouseMove={() => setPinned(index)}
													onClick={() => run(index)}
												>
													<span className="frn-dock-icon frn-dock-icon-small">
														{row.app.iconUrl ? (
															<img src={row.app.iconUrl} alt="" />
														) : isUpdate ? (
															<ArrowClockwiseIcon />
														) : (
															<DownloadSimpleIcon />
														)}
													</span>
													<span className="frn-dock-row-copy">
														<span>{row.app.name}</span>
														<small>
															{row.app.description || 'No description provided by the publisher.'}
														</small>
													</span>
													<span className="frn-dock-row-hint">
														{isUpdate ? 'Review update' : 'Install'}
													</span>
												</button>
											</li>
										</Fragment>
									)
								}
								return (
									<Fragment key="ask">
										<li className="frn-dock-section">Ask</li>
										<li>
											<button
												type="button"
												className="frn-dock-row"
												data-selected={isSelected}
												onMouseMove={() => setPinned(index)}
												onClick={() => run(index)}
											>
												<AgentAvatar
													url={session.avatarUrl}
													faces={session.avatarFaces}
													expression={session.expression}
													streaming={session.isStreaming}
													personalized={session.personalized}
													size={26}
												/>
												<span>
													Ask {session.agentName}: “{text}”
												</span>
												<span className="frn-dock-row-hint">opens the drawer</span>
											</button>
										</li>
									</Fragment>
								)
							})}
						</ul>
					) : (
						<div className="frn-dock-grid">
							{gridApps.map((app) => (
								<button
									key={app.id}
									type="button"
									className="frn-dock-tile"
									title={app.description || app.name}
									onClick={() => {
										launchApp(app)
										collapse()
									}}
									onContextMenu={onAppMenu ? (event) => onAppMenu(event, app) : undefined}
								>
									<span data-running={running.has(app.id)}>
										<AppIcon app={app} />
									</span>
									<span>{app.name}</span>
								</button>
							))}
							{shownInstalling.map((app) => (
								<div key={`installing:${app.id}`} className="frn-dock-tile" data-installing="true">
									<span className="frn-dock-icon">
										{app.iconUrl ? (
											<img src={app.iconUrl} alt="" />
										) : (
											app.name.slice(0, 1).toUpperCase()
										)}
										<span className="frn-dock-spinner" />
									</span>
									<span>{app.name}</span>
								</div>
							))}
							<button type="button" className="frn-dock-tile" data-store="true" onClick={openStore}>
								<span className="frn-dock-icon">
									<img src={appStoreIcon} alt="" />
								</span>
								<span>App Store</span>
							</button>
						</div>
					)}
				</div>
			) : null}

			<form className="frn-dock-bar" onSubmit={submit}>
				<span className="frn-dock-field-slot" aria-hidden="true" />
				<label className="frn-dock-field">
					<MagnifyingGlassIcon aria-hidden="true" />
					<input
						ref={inputRef}
						value={query}
						onChange={(event) => {
							setQuery(event.currentTarget.value)
							setPinned(null)
							setShowNotifications(false)
							setBrowseStore(false)
						}}
						onFocus={() => {
							if (!focused) setGridApps(rankApps(apps, recentIds))
							setFocused(true)
						}}
						onBlur={() => {
							setFocused(false)
							setShowNotifications(false)
							setBrowseStore(false)
						}}
						onKeyDown={onKeyDown}
						placeholder={focused ? `Search apps, or ask ${session.agentName}…` : 'Search'}
						aria-label={`Search apps or ask ${session.agentName}`}
						autoComplete="off"
						spellCheck={false}
					/>
				</label>
				<div className="frn-dock-apps" aria-hidden={expanded} inert={expanded}>
					{rowApps.map((app) => (
						<button
							key={app.id}
							type="button"
							className="frn-dock-app"
							data-running={running.has(app.id)}
							title={app.name}
							aria-label={`Open ${app.name}`}
							onClick={() => launchApp(app)}
							onContextMenu={onAppMenu ? (event) => onAppMenu(event, app) : undefined}
						>
							<AppIcon app={app} />
						</button>
					))}
				</div>
				<span className="frn-dock-separator" aria-hidden="true" />
				<div className="frn-dock-agent" data-agent={agentState}>
					<button
						type="button"
						className="frn-dock-agent-button"
						onClick={openConversation}
						aria-label={`Open conversation with ${session.agentName}`}
						title={`Open conversation with ${session.agentName}`}
					>
						<AgentAvatar
							url={session.avatarUrl}
							faces={session.avatarFaces}
							expression={session.expression}
							streaming={session.isStreaming}
							personalized={session.personalized}
							size={40}
							className="frn-dock-face"
						/>
					</button>
					{unread > 0 || showNotifications ? (
						<button
							type="button"
							className="frn-dock-notification-badge"
							title="Notifications"
							aria-label="Notifications"
							onMouseDown={(event) => event.preventDefault()}
							onClick={openNotifications}
						>
							{unread > 0 ? unread : <BellIcon />}
						</button>
					) : null}
				</div>
			</form>

			{consent
				? createPortal(
						<ConsentSheet
							target={consent}
							onConfirm={() => installRunner(consent.app)}
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
