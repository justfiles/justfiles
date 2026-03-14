import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router'
import App from './App'
import { MemoryPage } from './MemoryPage'
import { SettingsPage } from './SettingsPage'

export const rootRoute = createRootRoute({
	component: () => <Outlet />,
})

const indexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/',
	component: App,
})

const memoryRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/memory/$id',
	component: MemoryPage,
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
