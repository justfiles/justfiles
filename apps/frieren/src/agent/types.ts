// The message shapes now live in @justfiles/ui (shared with quay's launcher
// transcript); re-export them so existing imports of '../agent/types' keep
// working. The session / connection types below stay host-specific.
import type { AgentMessage } from '@justfiles/ui/Transcript'

export type { AgentMessage, ToolCallInfo } from '@justfiles/ui/Transcript'

export type ConnectionState = 'connecting' | 'ready' | 'disconnected'

export interface AgentSession {
	messages: AgentMessage[]
	input: string
	setInput: (value: string) => void
	userName: string
	agentName: string
	avatarUrl: string
	personalized: boolean
	refreshIdentity: () => Promise<void>
	isStreaming: boolean
	sendMessage: () => void
	abort: () => void
}

export interface AgentConnection {
	state: ConnectionState
}
