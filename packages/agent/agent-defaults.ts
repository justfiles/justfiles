import type { Volume } from '@justfiles/fs'
import { avatarsDir, PROFILE, soul } from './paths.ts'

// The platform's agent is ONE companion across terminals (web + desktop): these are the
// identity files it reads from the Volume, plus the built-in identity a MISSING one means,
// so it works out of the box with NO onboarding gate — personalization is opt-in.
//
// Deliberately pi-free (only `@justfiles/fs`): the agent runtime reads these files, while
// Settings imports the paths and the defaults for its independent read/write surface. Import
// from `@justfiles/agent/defaults`.
//
// The path constants are the PUBLIC spelling of package-internal paths.ts.
export const SOUL_PATH = soul()
export const AVATARS_DIR = avatarsDir()
export const PROFILE_PATH = PROFILE

/**
 * One avatar's directory — the id IS the avatar (see paths.ts for the layout). A ref in the
 * soul that is not `builtin/<id>` names one of these.
 *
 * Inside it: one file per STATE the avatar can be in, `resting` being the one it must have.
 * The file IS the state — `resting`, with no extension, because an extension could only say
 * which encoder the device that wrote it happened to have, and two devices answering that
 * differently for one state is two files sync will keep. A `resting.png` from an artist's
 * pack reads fine: the stem is the state, and nothing reads meaning into the rest. What a
 * file's bytes ARE is answered by `imageType`, and WHICH file holds a state by
 * `readImageFile`, both in `@justfiles/app/image-type` where every reader of one of these
 * directories can reach them.
 *
 * A state is what a write CLAIMS, so at most one file may hold one: `agent.putAvatarFile`
 * takes out every same-stem sibling as it publishes, whatever format that sibling was in.
 * Readers sort anyway — not as a preference order, as a stable one — so a pair that arrived
 * some other way (the Files app, a hand-made pack) resolves the same on every device, which
 * raw `readdir` order does not: it is sorted on one backend and insertion-ordered on another.
 */
export const avatarDir = (id: string): string => `${AVATARS_DIR}/${id}`

// The three identity files as ONE symbol, for a host that has to be told where they
// live: `settings`' `agent.*` methods edit them, and that capability is in
// `@justfiles/app` — which this package depends on, so it cannot import back. Passing
// this keeps one definition of where a soul lives (see the shared Settings host).
export const IDENTITY_PATHS = {
	soul: SOUL_PATH,
	avatars: AVATARS_DIR,
	profile: PROFILE_PATH
} as const

/**
 * The content hash that names an avatar's derived art: the first 8 hex chars of the resting
 * file's SHA-256. It is IN the `.gen/<hash>/` path, so art derived from a replaced resting
 * file can never be resolved as current — the lookup simply misses and the set regenerates.
 */
export async function avatarFaceHash(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
	return [...new Uint8Array(digest).slice(0, 4)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}

// ABSENCE IS THE BUILT-IN IDENTITY. Nothing writes these files to make the agent usable:
// a host booting against an empty Volume reads the defaults below and writes NOTHING, so an
// adopt-mine republish has no competing default writer to race (#425). The files appear the
// moment the user personalizes, and from then on they are the authoritative answer.
//
// So the default is TEXT, not a seed — every reader resolves a missing file to exactly these
// bytes, which makes "no file" and "the untouched default" one state on every host. That is
// also why they still carry `seeded: true`: a terminal detects "personalized" by the absence
// of that flag, and a soul the user has not written yet must not read as one they did.
//
// A neutral, terminal-agnostic persona, so a brand-new user gets a capable agent with no setup.
export const DEFAULT_AGENT_NAME = 'Computer'

export const DEFAULT_SOUL = `---
schema: frieren/agent-soul/v1
agent_name: Computer
seeded: true
---

You are Computer, a calm and capable companion. You help with whatever the user is working on — organising files, drafting text, answering questions, and getting things done on their machine. You are concise and clear, proactive without being pushy, and you never pretend to know something you don't. You adapt to how the user likes to work and remember what matters to them over time.
`

// An empty profile — no personal facts until the user chooses to share them.
export const DEFAULT_PROFILE = `---
schema: frieren/user-profile/v1
seeded: true
---
`

// The defaults keyed like IDENTITY_PATHS, for a host that has to be told BOTH: the `settings`
// Settings host resolves a missing file through these (see the shared Settings host), so the
// pane and the running agent read one identity. Passed for the same reason the paths are —
// `@justfiles/app` cannot import back into this package.
export const IDENTITY_DEFAULTS = {
	soul: DEFAULT_SOUL,
	profile: DEFAULT_PROFILE
} as const

const decoder = new TextDecoder()

// The two readers every host shares. A missing file is not an empty one.
export const readSoul = (volume: Volume): Promise<string> => readOr(volume, SOUL_PATH, DEFAULT_SOUL)
export const readProfile = (volume: Volume): Promise<string> =>
	readOr(volume, PROFILE_PATH, DEFAULT_PROFILE)

async function readOr(volume: Volume, path: string, fallback: string): Promise<string> {
	if (!(await volume.exists(path))) return fallback
	return decoder.decode(await volume.readFile(path))
}

// What the agent is called. The `settings` capability owns WRITING these files (it cannot
// import this package — the dependency runs the other way), but every host that starts a
// session needs the name for the session title and its notification banner.
export async function readAgentName(volume: Volume): Promise<string> {
	const text = await readSoul(volume)
	// Frontmatter only: the prose says the name too, and would match first otherwise.
	const match = /^\s*agent_name:\s*(.+?)\s*$/m.exec(text.split('\n---')[0] ?? '')
	return match?.[1] || DEFAULT_AGENT_NAME
}
