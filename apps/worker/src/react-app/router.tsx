import {
	createRootRoute,
	createRoute,
	createRouter,
	Navigate,
	useParams
} from '@tanstack/react-router'
import App from './App'
import { AppShell } from './AppShell'
import { MemoryPage } from './MemoryPage'
import { FilesIndexPage, FilesLayout } from './NotesLayout'
import { SettingsPage } from './SettingsPage'

export const rootRoute = createRootRoute({
	component: AppShell
})

function RootRedirect() {
	return <Navigate to="/files/scratch" replace />
}

const indexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/',
	component: RootRedirect
})

const filesRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/files',
	component: FilesLayout
})

const filesIndexRoute = createRoute({
	getParentRoute: () => filesRoute,
	path: '/',
	component: FilesIndexPage
})

const filesScratchRoute = createRoute({
	getParentRoute: () => filesRoute,
	path: 'scratch',
	component: App
})

function LegacyFilesDraftRedirect() {
	return <Navigate to="/files/scratch" replace />
}

const legacyFilesDraftRoute = createRoute({
	getParentRoute: () => filesRoute,
	path: 'draft',
	component: LegacyFilesDraftRedirect
})

function MemoryPageRoute() {
	const { id } = useParams({ strict: false }) as { id: string }
	return <MemoryPage key={id} />
}

const memoryRoute = createRoute({
	getParentRoute: () => filesRoute,
	path: '$id',
	component: MemoryPageRoute
})

function LegacyDraftRedirect() {
	return <Navigate to="/files/scratch" replace />
}

const legacyDraftRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/draft',
	component: LegacyDraftRedirect
})

const settingsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/settings',
	component: SettingsPage
})

const routeTree = rootRoute.addChildren([
	indexRoute,
	filesRoute.addChildren([filesIndexRoute, filesScratchRoute, legacyFilesDraftRoute, memoryRoute]),
	legacyDraftRoute,
	settingsRoute
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router
	}
	interface HistoryState {
		isNew?: boolean
	}
}
