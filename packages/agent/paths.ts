// The ONE place that spells the Volume layout the agent depends on. Every reader
// imports from here, and `prompts/filesystem.md` — the block that TELLS the agent this
// layout — is asserted against these constants in paths.test.ts, so the prose and the
// code cannot drift.
//
// Package-internal: it is not re-exported from index.ts. The few paths a host needs are
// the public names in `@justfiles/agent/defaults`.

export const NOTES_DIR = '/notes'
export const PICTURES_DIR = '/pictures' // == GENERATED_IMAGES_DIR (image capability); asserted in the test

export const PROFILE = '/system/user.md'
export const MEMORY = '/system/memory/core.md'
export const DAILY_DIR = '/system/memory/daily'
export const SKILLS_DIR = '/system/skills'
export const CONTEXT_DIR = '/system/context'

export const daily = (date: Date = new Date()) =>
	`${DAILY_DIR}/${date.toISOString().slice(0, 10)}.md`
export const agentDir = (agentId = 'main') => `/system/agents/${agentId}`
export const soul = (agentId = 'main') => `${agentDir(agentId)}/soul.md`
// AN AVATAR IS A DIRECTORY, and its name is its id: `avatars/mine/resting.png` is the state
// it rests in, `pleased.png` beside it is art someone AUTHORED (the user, or a pack they
// installed), and `.gen/<hash of resting>/pleased.png` is art the image model derived from
// exactly that resting file. Stem = state, extension = format, so nothing in the layout says
// "image" and nothing has to change for a video or a rig.
//
// Authored and derived split by DIRECTORY, not by filename: deleting `.gen` can never
// destroy something a human made, and replacing `resting.png` orphans one directory instead
// of needing a filename parser to tell orphans from current art.
export const avatarsDir = (agentId = 'main') => `${agentDir(agentId)}/avatars`
export const sessionsDir = (agentId = 'main') => `${agentDir(agentId)}/sessions`

// One shard per device, so a transcript file only ever has ONE writer and whole-file LWW
// during sync can never destroy a peer's appends. Readers union every shard sharing a
// session id (session.manager.impl.ts) — sharding is not the alternative to merging, it
// is the mechanism for it.
//
// Still named for when the conversation STARTED, and that stamp is shared across devices,
// so `ls` remains the chronological index AND every shard of one conversation sorts
// together. There is no sessions.json: the current session is DERIVED (see
// `currentSession`), because a single-key pointer file has one writer per device and
// therefore cannot survive sync.
export const sessionShard = (agentId: string, sessionId: string, at: Date, deviceId: string) =>
	`${sessionsDir(agentId)}/${stamp(at)}-${sessionId}.${deviceId}.jsonl`

const stamp = (at: Date) => `${at.toISOString().replace(/[:.]/g, '-').slice(0, 19)}Z`

// `<stamp>-<sessionId>.<deviceId>.jsonl`, and the two older shapes that predate it. A
// legacy file is simply a shard with no device suffix; nothing is migrated (#284 §8's
// precedent) and nothing on disk is invisible to the resolver.
//
// `startTs` is null for a pre-timestamp `<id>.jsonl` — unknown, not epoch. The reader
// derives one from the earliest entry rather than inventing 1970, so continuing such a
// session names its new shard for when the conversation actually started.
const SHARD = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z-([^.]+)(?:\.([^.]+))?\.jsonl$/
const PRE_TIMESTAMP = /^([^.]+)\.jsonl$/

export type SessionShard = {
	startTs: Date | null
	sessionId: string
	deviceId: string | null
}

// A one-time marker that a retired session's summary has been written to the journal. In its
// own directory so `ls` of the sessions dir stays the chronological transcript index, and
// deliberately not `.jsonl` so the shard reader ignores it either way.
export const sessionArchive = (agentId: string, sessionId: string) =>
	`${sessionsDir(agentId)}/archived/${sessionId}`

export function parseSessionShard(name: string): SessionShard | null {
	const m = SHARD.exec(name)
	if (m) {
		const [, date, h, min, s, sessionId, deviceId] = m
		return {
			startTs: new Date(`${date}T${h}:${min}:${s}Z`),
			sessionId: sessionId as string,
			deviceId: deviceId ?? null
		}
	}
	const legacy = PRE_TIMESTAMP.exec(name)
	if (legacy) return { startTs: null, sessionId: legacy[1] as string, deviceId: null }
	return null
}

// Prefixes the agent's shell must never read. ENFORCED in volumeFs, not asked for in the
// prompt — a prompt is not an access-control mechanism. The agent owns this access
// policy. The host supplies the same root to sync as its ignore list.
export const SECRET_PREFIXES = ['/private'] as const
