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
}
