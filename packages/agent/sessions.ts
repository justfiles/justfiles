import { type AgentSession, type AgentSessionOptions, createAgentSession } from './session.ts'

export interface AgentSessions {
	main(): AgentSession
}

export function createAgentSessions(
	options: AgentSessionOptions | (() => AgentSessionOptions)
): AgentSessions {
	let main: AgentSession | undefined
	return {
		main() {
			if (!main) main = createAgentSession(typeof options === 'function' ? options() : options)
			return main
		}
	}
}
