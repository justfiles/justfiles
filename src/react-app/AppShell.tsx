import { useAuth } from '@clerk/clerk-react'
import { Outlet } from '@tanstack/react-router'
import { useState } from 'react'
import { FiMenu } from 'react-icons/fi'
import { AuthWall } from './AuthWall'
import { CommandPalette } from './CommandPalette'
import { Sidebar } from './Sidebar'
import { SidebarContext } from './SidebarContext'
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

	function toggle() {
		setSidebarOpen((o: boolean) => {
			const next = !o
			try { localStorage.setItem(lsSidebarOpenKey(userId), String(next)) } catch {}
			return next
		})
	}

	return (
		<SidebarContext.Provider value={{ upsertEntry, removeEntry, refresh }}>
			<div className="flex h-screen overflow-hidden">
				{sidebarOpen && (
					<aside className="w-64 shrink-0 bg-base-200 border-r border-base-300 h-full overflow-hidden flex flex-col">
						<Sidebar entries={entries} onClose={toggle} />
					</aside>
				)}
				<div className="flex-1 min-w-0 h-full flex flex-col overflow-hidden relative">
					<CommandPalette />
					{!sidebarOpen && (
						<button
							type="button"
							onClick={toggle}
							title="Toggle sidebar"
							className="absolute top-3 left-3 z-10 p-1.5 rounded-lg hover:bg-base-200 text-base-content/40 hover:text-base-content/80 transition-colors cursor-pointer"
						>
							<FiMenu className="w-4 h-4" />
						</button>
					)}
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
