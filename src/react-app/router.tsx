import { createRootRoute, createRoute, createRouter, useParams } from '@tanstack/react-router'
import App from './App'
import { AppShell } from './AppShell'
import { MemoryPage } from './MemoryPage'
import { SettingsPage } from './SettingsPage'

export const rootRoute = createRootRoute({
	component: AppShell,
})

const indexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/',
	component: App,
})

function MemoryPageRoute() {
	const { id } = useParams({ strict: false }) as { id: string }
	return <MemoryPage key={id} />
}

const memoryRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/memory/$id',
	component: MemoryPageRoute,
})

const settingsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/settings',
	component: SettingsPage,
})

const routeTree = rootRoute.addChildren([indexRoute, memoryRoute, settingsRoute])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router
	}
}
