export type ActiveApp = { kind: 'builtin'; id: string } | { kind: 'app'; id: string }

export interface InstalledApp {
	id: string
	name: string
	description: string
	iconUrl?: string
	kind: 'builtin' | 'app'
}

// Dev-only host capability: upload a zipped app-system bundle to the kernel
// install endpoint. `uninstallApp` removes a previously-installed bundle by id.
export type Launcher = {
	activeApp: ActiveApp | null
	installedApps: InstalledApp[]
	launch: (app: InstalledApp) => void
	close: () => void
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

export interface ChatViewProps {
	session: ChatSession
	connection: ChatConnection
	apps?: { launcher: Launcher }
}
