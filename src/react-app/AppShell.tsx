import { useAuth } from '@clerk/clerk-react'
import { Outlet, useRouterState } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { AuthWall } from './AuthWall'
import { CommandPalette } from './CommandPalette'
import { PWAToast } from './PWAToast'
import { Sidebar } from './Sidebar'
import { SidebarContext } from './SidebarContext'
import { loadSettings } from './settings'
import { useSidebar } from './useSidebar'

function lsSidebarOpenKey(userId: string) {
	return `ghostore:${userId}:sidebar-open`
}

function loadSidebarOpen(userId: string): boolean {
	try { return localStorage.getItem(lsSidebarOpenKey(userId)) === 'true' } catch { return false }
}

function AppShellInner({ userId }: { userId: string }) {
	const { entries, upsertEntry, removeEntry, refresh } = useSidebar()
	const [sidebarOpen, setSidebarOpen] = useState(() => loadSidebarOpen(userId))
	const [theme, setTheme] = useState(() => loadSettings(userId).theme)
	const pathname = useRouterState({ select: (s) => s.location.pathname })

	useEffect(() => {
		document.documentElement.setAttribute('data-theme', theme)
	}, [theme])

	// Listen for theme changes saved by SettingsPage
	useEffect(() => {
		function onStorage(e: StorageEvent) {
			if (e.key?.includes(':settings') && e.newValue) {
				try {
					const parsed = JSON.parse(e.newValue) as { theme?: string }
					if (parsed.theme) setTheme(parsed.theme)
				} catch {}
			}
		}
		window.addEventListener('storage', onStorage)
		return () => window.removeEventListener('storage', onStorage)
	}, [])
	const showSidebar = sidebarOpen && pathname !== '/settings'

	function toggle() {
		setSidebarOpen((o: boolean) => {
			const next = !o
			try { localStorage.setItem(lsSidebarOpenKey(userId), String(next)) } catch {}
			return next
		})
	}

	return (
		<SidebarContext.Provider value={{ upsertEntry, removeEntry, refresh, toggleSidebar: toggle, sidebarOpen }}>
			<PWAToast />
			<div className="flex h-dvh">
				{showSidebar && (
					<>
						<div className="sm:hidden fixed inset-0 z-20 bg-black/30" onClick={toggle} />
						<aside className="fixed inset-y-0 left-0 z-30 sm:static sm:z-auto w-64 shrink-0 flex flex-col border-r border-base-300 bg-base-100">
							<Sidebar entries={entries} onClose={toggle} />
						</aside>
					</>
				)}
				<div className="flex-1 min-w-0 flex flex-col">
					<CommandPalette />
					<Outlet />
				</div>
			</div>
		</SidebarContext.Provider>
	)
}

export function AppShell() {
	const { isLoaded, isSignedIn, userId } = useAuth()

	if (!isLoaded) return <p className="m-8">Loading…</p>
	if (!isSignedIn || !userId) return <AuthWall />

	return <AppShellInner userId={userId} />
}
