export type ActiveApp = { kind: 'builtin'; id: string } | { kind: 'app'; id: string }

export interface InstalledApp {
	id: string
	name: string
	description: string
	iconUrl?: string
	kind: 'builtin' | 'app'
}

// `openApps` is the running set; `focusedId` is the topmost window key
// (`${kind}:${id}`). `activeApp` is a derived convenience: the focused app
// object, kept for chat-view callers that only know the single-app model.
// Dev-only host capability: upload a zipped app-system bundle to the kernel
// install endpoint. `uninstallApp` removes a previously-installed bundle by id.
export type Launcher = {
	openApps: ActiveApp[]
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
