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
	thinking?: string
	toolCalls?: ToolCallInfo[]
}

export type ActiveApp = {
	id: string
	ui: { url: string }
	state: unknown
} | null

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
	sendAppAction: (action: AppAction) => void
}
