export type ActiveApp = { id: string }

export interface InstalledApp {
	id: string
	name: string
	description: string
	iconUrl?: string
	// Version-stamped URL of the app's gui.js, e.g. /api/kernel/foo/gui.js?v=1.2.0.
	// Absent for builtins and for apps without a version in their manifest.
	guiUrl?: string
}

// `openApps` is the running set in stable insertion order; `focusStack` is
// the focus history (last element is the topmost app). Keeping them separate
// means we can re-order focus without re-keying the rendered windows, which
// would otherwise unmount the kernel app frame (and wipe canvas state).
// `focusedId` is `focusStack` tail. `activeApp` is the focused app object,
// kept for chat-view callers that only know the single-app model.
// Dev-only host capability: upload a zipped app-system bundle to the kernel
// install endpoint. `uninstallApp` removes a previously-installed bundle by id.
export type Launcher = {
	openApps: ActiveApp[]
	focusStack: string[]
	focusedId: string | null
	activeApp: ActiveApp | null
	installedApps: InstalledApp[]
	launch: (app: InstalledApp) => void
	close: () => void
	focus: (app: ActiveApp) => void
	installApp?: () => Promise<void>
	uninstallApp?: (id: string) => Promise<void>
}

export type ConnectionState = 'connecting' | 'ready' | 'disconnected'

export interface ToolCallInfo {
	id: string
	name: string
	args: unknown
	result?: unknown
	isError?: boolean
	status: 'running' | 'done'
}

export interface ChatMessage {
	id: string
	role: 'user' | 'assistant'
	content: string
	source?: 'user' | 'app'
	thinking?: string
	toolCalls?: ToolCallInfo[]
}

export interface ChatSession {
	messages: ChatMessage[]
	input: string
	setInput: (value: string) => void
	userName: string
	agentName: string
	isStreaming: boolean
	sendMessage: () => void
	abort: () => void
}

export interface ChatConnection {
	state: ConnectionState
	reconnect: () => void
}
