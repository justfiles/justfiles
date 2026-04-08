import { Navigate, createRootRoute, createRoute, createRouter, useParams } from '@tanstack/react-router'
import App from './App'
import { AppShell } from './AppShell'
import { MemoryPage } from './MemoryPage'
import { FilesIndexPage, FilesLayout } from './NotesLayout'
import { SettingsPage } from './SettingsPage'

export const rootRoute = createRootRoute({
	component: AppShell,
})

function RootRedirect() {
	return <Navigate to="/files" replace />
}

const indexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/',
	component: RootRedirect,
})

const filesRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/files',
	component: FilesLayout,
})

const filesIndexRoute = createRoute({
	getParentRoute: () => filesRoute,
	path: '/',
	component: FilesIndexPage,
})

function MemoryPageRoute() {
	const { id } = useParams({ strict: false }) as { id: string }
	return <MemoryPage key={id} />
}

const memoryRoute = createRoute({
	getParentRoute: () => filesRoute,
	path: '$id',
	component: MemoryPageRoute,
})

const draftRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/draft',
	component: App,
})

const settingsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/settings',
	component: SettingsPage,
})

const routeTree = rootRoute.addChildren([
	indexRoute,
	filesRoute.addChildren([filesIndexRoute, memoryRoute]),
	draftRoute,
	settingsRoute,
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router
	}
}
