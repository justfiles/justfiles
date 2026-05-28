import { type ReactNode, useState, useSyncExternalStore } from 'react'
import { useAgentClient } from '../os/hooks'
import { AgentContext, type AgentContextValue } from './hooks'

// The agent/messages feature. It consumes the AgentClient supplied by OS
// infrastructure and never touches the raw websocket itself; the client owns
// frame parsing and the session snapshot (BehaviorSubject pattern). This
// provider adds the only UI-local state the client can't hold: the draft input.
export function AgentProvider({ children }: { children: ReactNode }) {
	const agent = useAgentClient()
	const snapshot = useSyncExternalStore(agent.subscribe, agent.snapshot)
	const [input, setInput] = useState('')

	const sendMessage = () => {
		const text = input.trim()
		if (!text || snapshot.connectionState !== 'ready') return
		agent.prompt(text)
		setInput('')
	}

	const value: AgentContextValue = {
		session: {
			messages: snapshot.messages,
			input,
			setInput,
			userName: snapshot.userName,
			agentName: snapshot.agentName,
			isStreaming: snapshot.isStreaming,
			sendMessage,
			abort: () => agent.abort()
		},
		connection: { state: snapshot.connectionState }
	}

	return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>
}
