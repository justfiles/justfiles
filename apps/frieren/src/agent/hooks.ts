import { createContext, useContext } from 'react'
import type { AgentConnection, AgentSession } from './types'

export interface AgentContextValue {
	session: AgentSession
	connection: AgentConnection
}

export const AgentContext = createContext<AgentContextValue | null>(null)

function useAgentContext(): AgentContextValue {
	const value = useContext(AgentContext)
	if (!value) throw new Error('Agent hooks must be used inside <AgentProvider>')
	return value
}

export function useAgentSession(): AgentSession {
	return useAgentContext().session
}

export function useAgentConnection(): AgentConnection {
	return useAgentContext().connection
}
