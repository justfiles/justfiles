import { useAuth } from '@clerk/clerk-react'
import type { Expression } from '@justfiles/agent/expression'
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore
} from 'react'
import { openProfile } from '../fs'
import { useAgentClient } from '../os/hooks'
import { readAgentSoul, readAvatar, readAvatarFaces } from '../personalize/state'
import agentAvatarUrl from './agent-avatar.png'
import { requestFace } from './faces'
import { AgentContext, type AgentContextValue } from './hooks'

// How long a tab waits before asking for the same face again. A skip is often transient —
// right after personalization the worker's copy of `avatar.png` can still be behind the
// local one, so its hash does not match and it refuses — and a face that is asked for
// exactly once per tab would then stay missing until a reload.
const FACE_RETRY_MS = 5 * 60_000

// The agent/messages feature. It consumes the AgentClient supplied by OS
// infrastructure and never touches the raw websocket itself; the client owns
// frame parsing and the session snapshot (BehaviorSubject pattern). This
// provider adds the only UI-local state the client can't hold: the draft input.
export function AgentProvider({ children }: { children: ReactNode }) {
	const agent = useAgentClient()
	const snapshot = useSyncExternalStore(agent.subscribe, agent.snapshot)
	const { getToken } = useAuth()
	const [input, setInput] = useState('')
	const [identity, setIdentity] = useState({
		agentName: undefined as string | undefined,
		avatarUrl: agentAvatarUrl,
		// Null while on the bundled default avatar: nothing to derive faces from.
		hash: null as string | null,
		faces: {} as Partial<Record<Expression, string>>,
		personalized: false
	})

	const refreshIdentity = useCallback(async () => {
		const volume = await openProfile()
		const soul = await readAgentSoul(volume)
		const avatar = await readAvatar(volume)
		setIdentity({
			agentName: soul?.frontmatter.agent_name,
			avatarUrl: avatar?.url ?? agentAvatarUrl,
			hash: avatar?.hash ?? null,
			faces: avatar ? await readAvatarFaces(volume, avatar.hash) : {},
			personalized: soul?.frontmatter.seeded !== 'true' && soul !== null
		})
	}, [])

	useEffect(() => {
		void refreshIdentity().catch(() => {})
	}, [refreshIdentity])

	// Lazily fill in the face for an expression the agent just used. Fire-and-forget: the
	// base avatar stays on screen and the generated face lands on a later turn. Throttled per
	// (avatar, expression) rather than asked once — the worker owns the real dedupe and the
	// 24h backoff, this only keeps a tab from asking on every turn.
	const askedAt = useRef(new Map<string, number>())
	const { hash, faces } = identity
	const expression = snapshot.expression
	useEffect(() => {
		if (!expression || !hash || faces[expression]) return
		const key = `${hash}:${expression}`
		const now = Date.now()
		if (now - (askedAt.current.get(key) ?? -FACE_RETRY_MS) < FACE_RETRY_MS) return
		askedAt.current.set(key, now)
		void (async () => {
			const volume = await openProfile()
			if (await requestFace(volume, getToken, expression, hash)) await refreshIdentity()
		})().catch(() => {})
	}, [expression, hash, faces, getToken, refreshIdentity])

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
			avatarFaces: identity.faces,
			expression: snapshot.expression,
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
