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
import { requestFace } from './faces'
import { AgentContext, type AgentContextValue } from './hooks'
import { DEFAULT_AVATAR, readAgentSoul, readAvatar, watchIdentity } from './identity'

// How long a tab waits before asking for the same face again. A skip is often transient —
// right after an upload the worker's copy of the resting file can still be behind the local
// one, so its hash does not match and it refuses — and a face that is asked for exactly once
// per tab would then stay missing until a reload.
const FACE_RETRY_MS = 5 * 60_000

// The agent/messages feature. It consumes the AgentClient supplied by OS
// infrastructure and never touches the raw websocket itself; the client owns
// frame parsing and the session snapshot (BehaviorSubject pattern). This
// provider adds the only UI-local state the client can't hold: the draft input.
export function AgentProvider({ children }: { children: ReactNode }) {
	const agent = useAgentClient()
	const snapshot = useSyncExternalStore(agent.subscribe, agent.snapshot)
	const { getToken } = useAuth()
	const [inputs, setInputs] = useState<Record<string, string>>({})
	const [identity, setIdentity] = useState({
		agentName: undefined as string | undefined,
		// Until the first read lands, the default built-in: it is in the bundle, so there is
		// nothing to wait for and no hole where a face goes.
		avatar: undefined as string | undefined,
		avatarUrl: DEFAULT_AVATAR.url,
		// Null on built-in art — there is nothing to derive faces FROM, and nothing to derive:
		// the set arrives complete.
		hash: null as string | null,
		faces: DEFAULT_AVATAR.faces,
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
		// `avatar:` names a SOURCE: `builtin/<id>` is art in the app bundle (no bytes on the
		// volume, nothing to sync), anything else is an id under `<agent dir>/avatars`.
		const ref = soul?.frontmatter.avatar
		// Every await is done before the guard — including the faces, which are the slow part and
		// the whole reason the reads can finish out of order.
		const avatar = await readAvatar(volume, ref)
		if (mine !== reading.current) return
		setIdentity({
			agentName: soul?.frontmatter.agent_name,
			avatar: ref,
			avatarUrl: avatar.url,
			hash: avatar.hash,
			faces: avatar.faces,
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
	// avatar whose bytes are ON THE VOLUME, since a built-in leaves `hash` null, and only for a
	// state nobody has authored. Fire-and-forget: the resting face stays on screen and the
	// generated one lands on a later turn. Throttled per (resting file, expression) rather than
	// asked once — the worker owns the real dedupe and the 24h backoff, this only keeps a tab
	// from asking on every turn.
	const askedAt = useRef(new Map<string, number>())
	const { avatar, hash, faces } = identity
	const expression = snapshot.expression
	useEffect(() => {
		if (!expression || !avatar || !hash || faces[expression]) return
		const key = `${hash}:${expression}`
		const now = Date.now()
		if (now - (askedAt.current.get(key) ?? -FACE_RETRY_MS) < FACE_RETRY_MS) return
		askedAt.current.set(key, now)
		void (async () => {
			const volume = await openProfile()
			// `identity.faces` is a snapshot, and sync can land a face another device generated
			// without anything refreshing it. Re-read before paying for an image: a face already
			// on the volume just needs to be picked up.
			if ((await readAvatar(volume, avatar)).faces[expression]) {
				await refreshIdentity()
				return
			}
			if (await requestFace(volume, getToken, avatar, expression, hash)) await refreshIdentity()
		})().catch(() => {})
	}, [expression, avatar, hash, faces, getToken, refreshIdentity])

	const value: AgentContextValue = {
		agent,
		inputs,
		setInput: (agentId, value) => setInputs((current) => ({ ...current, [agentId ?? '']: value })),
		identity: {
			agentName: identity.agentName,
			avatarUrl: identity.avatarUrl,
			faces: identity.faces,
			personalized: identity.personalized
		},
		refreshIdentity
	}

	return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>
}
