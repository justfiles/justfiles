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

export type ActiveApp = {
	id: string
	ui: { url: string }
	state: unknown
} | null

export interface InstalledApp {
	id: string
	name: string
	description: string
	iconUrl?: string
}

// Actions flow through the registry; at this wire boundary they're opaque.
export type AppAction = { type: string; payload: unknown }

export interface ChatViewProps {
	messages: ChatMessage[]
	input: string
	setInput: (value: string) => void
	userName: string
	agentName: string
	connectionState: ConnectionState
	isStreaming: boolean
	sendMessage: () => void
	abort: () => void
	reconnect: () => void
	activeApp: ActiveApp
	installedApps: InstalledApp[]
	launchApp: (id: string) => void
	closeApp: () => void
	sendAppAction: (action: AppAction) => void
}
