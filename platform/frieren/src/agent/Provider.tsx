import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { openProfile } from '../fs'
import { useOsClient } from '../os/hooks'
import { GAMEBOY_AVATAR } from './avatarAppearance'
import { AgentContext, type AgentContextValue } from './hooks'
import { readAgentSoul, watchIdentity } from './identity'

// The agent/messages feature. It consumes the AgentClient supplied by OS
// infrastructure and never touches the raw websocket itself; the client owns
// frame parsing and the session snapshot (BehaviorSubject pattern). This
// provider adds the only UI-local state the client can't hold: the draft input.
export function AgentProvider({ children }: { children: ReactNode }) {
	const agent = useOsClient().agent
	const [inputs, setInputs] = useState<Record<string, string>>({})
	const [identity, setIdentity] = useState({
		agentName: undefined as string | undefined,
		appearance: GAMEBOY_AVATAR,
		personalized: false
	})

	// Only the newest read may paint. A bind writes the soul and the avatar's files, so the
	// watch fires more than once and two reads overlap — landing in the wrong order would put
	// the face they are no longer wearing back on the shell until some later identity event.
	const reading = useRef(0)
	const refreshIdentity = useCallback(async () => {
		const mine = ++reading.current
		const volume = await openProfile()
		const soul = await readAgentSoul(volume)
		if (mine !== reading.current) return
		setIdentity({
			agentName: soul?.frontmatter.agent_name,
			appearance: GAMEBOY_AVATAR,
			personalized: soul?.frontmatter.seeded !== 'true' && soul !== null
		})
	}, [])

	// The shell does not write these files any more — Settings' Agent pane does, in an app
	// frame, and so does another device through sync. So watch them: an identity change
	// arrives the same way for a rename on this machine and a rename made on the phone.
	useEffect(() => {
		let cancelled = false
		let unwatch: (() => void) | undefined
		void (async () => {
			const volume = await openProfile()
			if (cancelled) return
			unwatch = await watchIdentity(volume, () => void refreshIdentity().catch(() => {}))
			void refreshIdentity().catch(() => {})
		})().catch(() => {})
		return () => {
			cancelled = true
			unwatch?.()
		}
	}, [refreshIdentity])

	// Canvas skins draw every expression themselves, so there is no face file to fill in.
	const ensureFace = useCallback<AgentContextValue['ensureFace']>(() => {}, [])

	const value: AgentContextValue = {
		agent,
		inputs,
		setInput: (agentId, value) => setInputs((current) => ({ ...current, [agentId ?? '']: value })),
		identity: {
			agentName: identity.agentName,
			appearance: identity.appearance,
			personalized: identity.personalized
		},
		ensureFace,
		refreshIdentity
	}

	return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>
}
