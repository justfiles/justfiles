import type { AppLauncher, AppRelay } from '@justfiles/app'

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
	apps?: {
		launcher: AppLauncher
		setAppDescribe: (fn: (() => Promise<string | null>) | null) => void
		relay: AppRelay
	}
}
