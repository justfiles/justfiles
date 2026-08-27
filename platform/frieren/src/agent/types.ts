// The message shapes now live in @justfiles/ui (shared with quay's launcher
// transcript); re-export them so existing imports of '../agent/types' keep
// working. The session / connection types below stay host-specific.
import type { Expression } from '@justfiles/agent/expression'
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
	// Per-expression faces found on the volume (may be empty — then the base avatar is used).
	avatarFaces: Partial<Record<Expression, string>>
	// The agent's latest expression tag this turn; drives which face is shown.
	expression: Expression | null
	personalized: boolean
	refreshIdentity: () => Promise<void>
	isStreaming: boolean
	isLoadingHistory: boolean
	sendMessage: () => void
	abort: () => void
	loadHistory: () => void
}

export interface AgentConnection {
	state: ConnectionState
}
