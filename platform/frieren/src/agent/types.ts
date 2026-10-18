// The message shapes now live in @justfiles/ui (shared with the Mac launcher
// transcript); re-export them so existing imports of '../agent/types' keep
// working. The session / connection types below stay host-specific.
import type { Expression } from '@justfiles/agent/expression'
import type { ActivityDetailResult } from '@justfiles/agent/protocol'
import type { Notification } from '@justfiles/app/capabilities/notify'
import type { TranscriptRow } from '@justfiles/ui/Transcript'
import type { AvatarAppearance } from './avatarAppearance'

export type { AgentMessage, ToolCallInfo, TranscriptRow } from '@justfiles/ui/Transcript'

export type ConnectionState = 'connecting' | 'ready' | 'disconnected'

export interface AgentSession {
	messages: TranscriptRow[]
	input: string
	setInput: (value: string) => void
	userName: string
	agentName: string
	avatar: AvatarAppearance
	// The agent's latest expression tag this turn; drives which face is shown.
	expression: Expression | null
	personalized: boolean
	refreshIdentity: () => Promise<void>
	isStreaming: boolean
	isLoadingHistory: boolean
	notice: Notification | null
	clearNotice: () => void
	loadActivityDetail: (detailId: string) => Promise<ActivityDetailResult>
	sendMessage: () => void
	abort: () => void
}

export interface AgentConnection {
	state: ConnectionState
}
