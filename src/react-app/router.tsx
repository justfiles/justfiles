import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router'
import App from './App'
import { MemoryPage } from './MemoryPage'

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

const routeTree = rootRoute.addChildren([indexRoute, memoryRoute])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router
	}
}
