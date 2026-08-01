import { useAuth } from '@clerk/clerk-react'
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
import { builtinFaces } from './builtin'
import { requestFace } from './faces'
import { AgentContext, type AgentContextValue } from './hooks'
import { readAgentSoul, readAvatar, readAvatarFaces, watchIdentity } from './identity'

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
		avatarUrl: builtinFaces(undefined).url,
		// Null on built-in art — there is nothing to derive faces FROM, and nothing to derive:
		// the set arrives complete (see ./builtin.ts).
		hash: null as string | null,
		faces: builtinFaces(undefined).faces,
		personalized: false
	})

	// Only the newest read may paint. Binding writes `soul.md` and then clears `avatar.png`,
	// so the watch fires twice and two reads overlap — and the FIRST one is the slow one: it
	// still sees the photo and goes on to load its expression faces, while the second finds
	// the photo gone and has the built-in set in hand already. Landing in that order would
	// put the deleted photo back on the shell until some later identity event.
	const reading = useRef(0)
	const refreshIdentity = useCallback(async () => {
		const mine = ++reading.current
		const volume = await openProfile()
		const soul = await readAgentSoul(volume)
		// `avatar.png` exists only when the user uploaded their own photo; a built-in variant is
		// a word in the soul, so it costs no bytes and rides along with the identity file.
		const avatar = await readAvatar(volume)
		const builtin = builtinFaces(soul?.frontmatter.avatar_variant)
		if (mine !== reading.current) return
		setIdentity({
			agentName: soul?.frontmatter.agent_name,
			avatarUrl: avatar?.url ?? builtin.url,
			hash: avatar?.hash ?? null,
			faces: avatar ? await readAvatarFaces(volume, avatar.hash) : builtin.faces,
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

	// Lazily fill in the face for an expression the agent just used — only reachable for an
	// UPLOADED avatar, since a built-in variant arrives with its whole set and leaves `hash`
	// null. Fire-and-forget: the base avatar stays on screen and the generated face lands on a
	// later turn. Throttled per (avatar, expression) rather than asked once — the worker owns
	// the real dedupe and the 24h backoff, this only keeps a tab from asking on every turn.
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
			// `identity.faces` is a snapshot, and sync can land a face another device generated
			// without anything refreshing it. Re-read before paying for an image: a face already
			// on the volume just needs to be picked up.
			if ((await readAvatarFaces(volume, hash))[expression]) {
				await refreshIdentity()
				return
			}
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
