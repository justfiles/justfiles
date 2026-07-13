import { SignInButton, UserButton, useAuth } from '@clerk/clerk-react'
import { useState, useSyncExternalStore } from 'react'
import { ContextMenu, type ContextMenuItem, useContextMenu } from '@/components/ContextMenu'
import { Menubar } from '@/components/Menubar'
import { useAgentConnection, useAgentSession } from '../agent/hooks'
import { MessagesPanel } from '../agent/MessagesPanel'
import type { ConnectionState } from '../agent/types'
import { AppViewport } from '../apps/AppViewport'
import { resolveAppTitle } from '../apps/catalog'
import { useAppCommands, useInstalledApps } from '../apps/hooks'
import type { InstalledApp } from '../apps/types'
import { activeStatus, onActiveStatusChange, type SyncStatus } from '../fs'
import { AppWindow } from '../os/AppWindow'
import { useOsStore } from '../os/hooks'
import { selectFocusedAppId, selectOpenWindows, selectVisibleFullscreenId } from '../os/selectors'
import type { OsWindow } from '../os/state'
import { PersonalizePanel } from '../personalize/PersonalizePanel'
import { ResetPanel } from '../reset/ResetPanel'
import { Omnibar } from './Omnibar'

const statusDotColor: Record<ConnectionState, string> = {
	ready: '#22c55e',
	connecting: '#f59e0b',
	disconnected: '#ef4444'
}

function syncLabel(status: SyncStatus): string {
	switch (status) {
		case 'synced':
			return 'Synced'
		case 'syncing':
			return 'Syncing…'
		case 'error':
			return 'Sync error'
		default:
			return 'Connecting…'
	}
}

function subscribeOnline(onChange: () => void): () => void {
	window.addEventListener('online', onChange)
	window.addEventListener('offline', onChange)
	return () => {
		window.removeEventListener('online', onChange)
		window.removeEventListener('offline', onChange)
	}
}

// Backend status: auth is optional, so this reflects the sync state when signed
// in and "Signed out" otherwise. The desktop boots and runs regardless.
function BackendStatus() {
	const { isSignedIn } = useAuth()
	const status = useSyncExternalStore(
		onActiveStatusChange,
		activeStatus,
		() => 'local-only' as SyncStatus
	)
	const online = useSyncExternalStore(
		subscribeOnline,
		() => navigator.onLine,
		() => true
	)
	const label = !isSignedIn ? 'Signed out' : !online ? 'Offline' : syncLabel(status)
	return (
		<span className="frn-menubar-status" title={`Backend: ${label}`}>
			{label}
		</span>
	)
}

// Re-render the desktop only when the set/order of windows changes, not on
// every rect/mode edit — each AppWindow subscribes to its own slice.
function sameWindowIds(a: OsWindow[], b: OsWindow[]): boolean {
	return a.length === b.length && a.every((w, i) => w.id === b[i]?.id)
}

export function DesktopShell({ onSwitchUser }: { onSwitchUser: () => void }) {
	const { isSignedIn } = useAuth()
	const installedApps = useInstalledApps()
	const { launchApp, installApp, uninstallApp } = useAppCommands()
	const connection = useAgentConnection()
	const { agentName } = useAgentSession()
	const menu = useContextMenu()
	const focusedAppId = useOsStore(selectFocusedAppId)

	const windows = useOsStore(
		(state) => (state.booted ? selectOpenWindows(state) : []),
		sameWindowIds
	)
	const fullscreenId = useOsStore(selectVisibleFullscreenId)
	const [personalizeOpen, setPersonalizeOpen] = useState(false)
	const [resetOpen, setResetOpen] = useState(false)
	// Debug-gated: the reset affordances are dev-only for now (dev build, or opt in
	// via `localStorage.frieren-debug = 1`).
	const resetDebugEnabled =
		import.meta.env.DEV ||
		(typeof localStorage !== 'undefined' && localStorage.getItem('frieren-debug') === '1')

	const desktopMenuItems: ContextMenuItem[] = [
		{ label: 'Personalize…', onSelect: () => setPersonalizeOpen(true) },
		{ label: 'Switch User…', onSelect: onSwitchUser },
		...(resetDebugEnabled
			? ([{ label: 'Reset sync…', onSelect: () => setResetOpen(true) }] as ContextMenuItem[])
			: []),
		{ separator: true },
		{ label: 'Change Wallpaper…', disabled: true, onSelect: () => {} },
		{ separator: true },
		{ label: 'Clean Up', disabled: true, onSelect: () => {} }
	]

	const appMenuItems = (app: InstalledApp): ContextMenuItem[] => [
		{ label: 'Open', onSelect: () => launchApp(app) },
		{ separator: true },
		{
			label: 'Uninstall',
			onSelect: () => {
				if (confirm(`Uninstall "${app.name}"?`)) void uninstallApp(app.id)
			}
		}
	]

	// The focused app labels the menubar (macOS-style); the desktop falls back to
	// the shell name. Version rides alongside in muted text when the app declares one.
	const focusedApp = focusedAppId ? installedApps.find((app) => app.id === focusedAppId) : undefined

	return (
		<div className="frn-shell">
			{fullscreenId ? null : (
				<Menubar>
					<div className="frn-menubar-group">
						<span className="frn-menubar-title">
							{focusedApp?.name ?? 'Frieren'}
							{focusedApp?.version ? (
								<span className="frn-menubar-version">{focusedApp.version}</span>
							) : null}
						</span>
					</div>
					<div className="frn-menubar-group">
						<BackendStatus />
						<span
							className="frn-status-dot"
							style={{ background: statusDotColor[connection.state] }}
							title={connection.state}
						/>
						<button
							type="button"
							className="frn-menubar-btn"
							onClick={() => void installApp()}
							title="Install app from zip"
						>
							Install
						</button>
						{isSignedIn ? (
							<UserButton appearance={{ elements: { avatarBox: 'w-6 h-6' } }} />
						) : (
							<SignInButton>
								<button type="button" className="frn-menubar-btn">
									Sign in
								</button>
							</SignInButton>
						)}
					</div>
				</Menubar>
			)}

			{/* biome-ignore lint/a11y/noStaticElementInteractions: contextmenu is a supplemental pointer gesture on the desktop region */}
			<div className="frn-desktop" onContextMenu={(event) => menu.open(event, desktopMenuItems)}>
				{/* Windows live in their own layer so the desktop can dim + recede behind
				    the omnibar's expanded sheet without transforming the omnibar itself.
				    The body is picked by window kind: app windows present their stage,
				    the agent window views the conversation session. */}
				<div className="frn-desktop-windows">
					{windows.map((window) => (
						<AppWindow
							key={window.id}
							id={window.id}
							title={
								window.appId
									? resolveAppTitle(installedApps, window.appId, window.title)
									: agentName
							}
						>
							{window.appId ? <AppViewport id={window.id} /> : <MessagesPanel />}
						</AppWindow>
					))}
				</div>
				{fullscreenId ? null : (
					<Omnibar onAppMenu={(event, app) => menu.open(event, appMenuItems(app))} />
				)}
			</div>
			<ContextMenu state={menu.state} onClose={menu.close} />
			{personalizeOpen ? <PersonalizePanel onClose={() => setPersonalizeOpen(false)} /> : null}
			{resetOpen ? <ResetPanel onClose={() => setResetOpen(false)} /> : null}
		</div>
	)
}
