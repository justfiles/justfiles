import { type ReactNode, useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { openProfile } from '../fs'
import { useAgentClient } from '../os/hooks'
import { PATHS, readAgentSoul } from '../personalize/state'
import agentAvatarUrl from './agent-avatar.png'
import { AgentContext, type AgentContextValue } from './hooks'

function toDataUrl(bytes: Uint8Array): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		reader.onload = () => resolve(String(reader.result))
		reader.onerror = () => reject(reader.error)
		reader.readAsDataURL(new Blob([bytes as BlobPart], { type: 'image/png' }))
	})
}

// The agent/messages feature. It consumes the AgentClient supplied by OS
// infrastructure and never touches the raw websocket itself; the client owns
// frame parsing and the session snapshot (BehaviorSubject pattern). This
// provider adds the only UI-local state the client can't hold: the draft input.
export function AgentProvider({ children }: { children: ReactNode }) {
	const agent = useAgentClient()
	const snapshot = useSyncExternalStore(agent.subscribe, agent.snapshot)
	const [input, setInput] = useState('')
	const [identity, setIdentity] = useState({
		agentName: undefined as string | undefined,
		avatarUrl: agentAvatarUrl,
		personalized: false
	})

	const refreshIdentity = useCallback(async () => {
		const volume = await openProfile()
		const soul = await readAgentSoul(volume)
		let avatarUrl = agentAvatarUrl
		if (await volume.exists(PATHS.avatar)) {
			avatarUrl = await toDataUrl(await volume.readFile(PATHS.avatar))
		}
		setIdentity({
			agentName: soul?.frontmatter.agent_name,
			avatarUrl,
			personalized: soul?.frontmatter.seeded !== 'true' && soul !== null
		})
	}, [])

	useEffect(() => {
		void refreshIdentity().catch(() => {})
	}, [refreshIdentity])

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
			agentName: identity.agentName ?? snapshot.agentName,
			avatarUrl: identity.avatarUrl,
			personalized: identity.personalized,
			refreshIdentity,
			isStreaming: snapshot.isStreaming,
			sendMessage,
			abort: () => agent.abort()
		},
		connection: { state: snapshot.connectionState }
	}

	return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>
}
