import type { Expression } from '@justfiles/agent/expression'
import { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from 'react'
import type { AgentClient } from '../os/client'
import type { AgentConnection, AgentSession } from './types'

export interface AgentContextValue {
	agent: (agentId?: string) => AgentClient
	inputs: Record<string, string>
	setInput: (agentId: string | undefined, value: string) => void
	identity: {
		agentName?: string
		avatarUrl: string
		faces: Partial<Record<Expression, string>>
		personalized: boolean
	}
	ensureFace: (expression: Expression | null) => void
	refreshIdentity: () => Promise<void>
}

export const AgentContext = createContext<AgentContextValue | null>(null)

function useAgentContext(): AgentContextValue {
	const value = useContext(AgentContext)
	if (!value) throw new Error('Agent hooks must be used inside <AgentProvider>')
	return value
}

export function useAgentSession(agentId?: string): AgentSession {
	const {
		agent: getAgent,
		inputs,
		setInput,
		identity,
		ensureFace,
		refreshIdentity
	} = useAgentContext()
	const agent = getAgent(agentId)
	useEffect(() => agent.connect(), [agent])
	const subscribe = useCallback((listener: () => void) => agent.subscribe(listener), [agent])
	const snapshot = useSyncExternalStore(subscribe, agent.snapshot)
	useEffect(() => ensureFace(snapshot.expression), [ensureFace, snapshot.expression])
	const input = inputs[agentId ?? ''] ?? ''
	return {
		messages: snapshot.messages,
		input,
		setInput: (value) => setInput(agentId, value),
		userName: snapshot.userName,
		agentName: identity.agentName ?? snapshot.agentName,
		avatarUrl: identity.avatarUrl,
		avatarFaces: identity.faces,
		expression: snapshot.expression,
		personalized: identity.personalized,
		refreshIdentity,
		isStreaming: snapshot.isStreaming,
		isLoadingHistory: snapshot.isLoadingHistory,
		loadActivityDetail: agent.loadActivityDetail,
		sendMessage: () => {
			const text = input.trim()
			if (text) void agent.prompt(text).then((accepted) => accepted && setInput(agentId, ''))
		},
		abort: agent.abort
	}
}

export function useAgentConnection(agentId?: string): AgentConnection {
	const agent = useAgentContext().agent(agentId)
	const snapshot = useSyncExternalStore(agent.subscribe, agent.snapshot)
	return { state: snapshot.connectionState }
}
