export interface InstalledApp {
	id: string
	name: string
	description: string
	iconUrl?: string
	// Version-stamped URL of the app's gui.js, e.g. /api/kernel/foo/gui.js?v=1.2.0.
	// Absent for builtins and for apps without a version in their manifest.
	guiUrl?: string
}

// Open-window state (which apps are running, focus order, geometry) now lives
// in the OS store; the launcher only carries the installed-app catalog and the
// commands that mutate it. Dev-only host capabilities `installApp`/
// `uninstallApp` upload/remove a zipped app-system bundle via the kernel.
export type Launcher = {
	installedApps: InstalledApp[]
	launch: (app: InstalledApp) => void
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
