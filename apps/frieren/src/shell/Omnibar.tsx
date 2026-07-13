import { Transcript } from '@justfiles/ui/Transcript'
import { ArrowsOutIcon, MagnifyingGlassIcon, SparkleIcon } from '@phosphor-icons/react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useAgentConnection, useAgentSession } from '../agent/hooks'
import { useAppCommands, useInstalledApps } from '../apps/hooks'
import type { InstalledApp } from '../apps/types'
import { useAgentClient, useOsDispatch, useOsStore } from '../os/hooks'
import { AGENT_WINDOW_ID } from '../os/state'

// The omnibar: one intent surface at the bottom of the desktop. You type, and it
// routes — an installed app match launches, anything else asks the agent. The
// input is fixed at the bottom; everything grows upward from it, most-relevant
// nearest the input (see design/01-omnibar.md). This replaces the dock: the app
// grid it shows at rest is where launching now lives.

type Row = { kind: 'app'; app: InstalledApp } | { kind: 'ask' }

function filterApps(apps: InstalledApp[], query: string): InstalledApp[] {
	const needle = query.toLowerCase()
	if (!needle) return apps
	return apps.filter(
		(app) =>
			app.name.toLowerCase().includes(needle) ||
			app.id.toLowerCase().includes(needle) ||
			app.description.toLowerCase().includes(needle)
	)
}

export function Omnibar({
	onAppMenu
}: {
	// Right-click on an app tile reuses the desktop's shared context menu
	// (Open / Uninstall), so deleting the dock doesn't strand uninstall.
	onAppMenu?: (event: ReactMouseEvent, app: InstalledApp) => void
}) {
	const apps = useInstalledApps()
	const { launchApp } = useAppCommands()
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
	const inputRef = useRef<HTMLInputElement>(null)

	const text = query.trim()
	const matches = useMemo(() => filterApps(apps, text), [apps, text])

	// One flat, keyboard-navigable list, laid out visually top→bottom: weaker app
	// matches up top, the best match just above the pinned "Ask Frieren" row, which
	// sits directly above the input as the universal fall-through.
	const rows = useMemo<Row[]>(
		() => [...matches.map((app): Row => ({ kind: 'app', app })).reverse(), { kind: 'ask' }],
		[matches]
	)
	// Default target: the best app match when something matched, else "Ask Frieren".
	const defaultIndex = matches.length ? rows.length - 2 : rows.length - 1
	const selected = pinned === null ? defaultIndex : Math.min(pinned, rows.length - 1)

	// Coexistence rule: while the conversation window is open, the sheet stays in
	// launcher mode — no duplicated live transcript. The pill still sends to the
	// session; replies land in the window.
	const agentWindowOpen = useOsStore((s) => !!s.windows[AGENT_WINDOW_ID])
	// When the window closes, hand the transcript back to the sheet so the pill
	// stays the way back into the conversation.
	const hadWindow = useRef(agentWindowOpen)
	useEffect(() => {
		if (hadWindow.current && !agentWindowOpen && session.messages.length > 0) setChatOpen(true)
		hadWindow.current = agentWindowOpen
	}, [agentWindowOpen, session.messages.length])
	const expanded = focused || (chatOpen && session.isStreaming && !agentWindowOpen)
	const showTranscript = chatOpen && text === '' && !agentWindowOpen
	const showList = text !== ''

	// Presence: the pill is the ambient signal that the agent is doing something.
	// Two derivable states — `working` while a reply streams (glow), and
	// `needs-you` when the last message is an unanswered multiple-choice question
	// (pulse + the question shown in the pill). Everything else is idle.
	const lastMessage = session.messages[session.messages.length - 1]
	const needsYou =
		!session.isStreaming && lastMessage?.role === 'assistant' && !!lastMessage.options?.length
	const agentState = session.isStreaming ? 'working' : needsYou ? 'needs-you' : 'idle'
	// The question only occupies the pill while unfocused — focusing hands the
	// slot back to the input (and opens the transcript so the options are there).
	const placeholder =
		!focused && needsYou
			? `${session.agentName}: ${lastMessage?.content.trim() || 'needs your input…'}`
			: `Search apps, or talk to ${session.agentName}…`

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
			if (text !== '') setQuery('')
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
		<div className="frn-omnibar" data-expanded={expanded} data-agent={agentState}>
			{expanded ? (
				/* biome-ignore lint/a11y/noStaticElementInteractions: mousedown-preventDefault keeps
				   focus in the input so surface clicks don't collapse the sheet mid-click. Inline
				   text selection is sacrificed; expand-to-window is the copy escape hatch. */
				<div className="frn-omnibar-surface" onMouseDown={(event) => event.preventDefault()}>
					{showTranscript ? (
						<div className="frn-omnibar-chat">
							<div className="frn-omnibar-chat-head">
								<span>{session.agentName}</span>
								<button
									type="button"
									className="frn-omnibar-expand"
									title="Expand conversation"
									aria-label="Expand conversation"
									onClick={() => {
										dispatch({ type: 'agent.openWindow' })
										setChatOpen(false)
										inputRef.current?.blur()
									}}
								>
									<ArrowsOutIcon />
								</button>
							</div>
							<Transcript
								messages={session.messages}
								isStreaming={session.isStreaming}
								onOption={(label) => ask(label)}
							/>
						</div>
					) : showList ? (
						<ul className="frn-omnibar-list">
							{rows.map((row, index) => {
								const isSelected = index === selected
								if (row.kind === 'app') {
									return (
										<li key={row.app.id}>
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
												<span className="frn-omnibar-row-label">{row.app.name}</span>
											</button>
										</li>
									)
								}
								return (
									<li key="ask" data-divider={matches.length > 0}>
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
										</button>
									</li>
								)
							})}
						</ul>
					) : apps.length > 0 ? (
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
					}}
					onFocus={() => {
						setFocused(true)
						// Engaging while the agent waits on a question lands on the
						// question: in the window if it's open, else the sheet transcript.
						if (needsYou) {
							if (agentWindowOpen) dispatch({ type: 'window.focus', id: AGENT_WINDOW_ID })
							else setChatOpen(true)
						}
					}}
					onBlur={() => setFocused(false)}
					onKeyDown={onKeyDown}
					placeholder={placeholder}
					aria-label="Search apps or talk to Frieren"
					autoComplete="off"
					spellCheck={false}
				/>
			</form>
		</div>
	)
}
