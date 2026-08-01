import type { Volume } from '@justfiles/fs'
import { agentDir, avatarsDir, PROFILE, soul } from './paths.ts'

// The platform's agent is ONE companion across terminals (web + desktop): these are the
// identity files it reads from the Volume, plus the sensible defaults it seeds so it works
// out of the box with NO onboarding gate — personalization is opt-in and overwrites them.
//
// Deliberately pi-free (only `@justfiles/fs`): `createAssistant` seeds through it, and a
// terminal's *client* can import the paths + seeder for its own pre-seed / personalization
// UI without pulling in the agent runtime. Import from `@justfiles/agent/defaults`.
//
// The path constants are the PUBLIC spelling of package-internal paths.ts.
export const SOUL_PATH = soul()
export const AVATARS_DIR = avatarsDir()
export const PROFILE_PATH = PROFILE
export const AGENT_DIR = agentDir()

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
// this keeps one definition of where a soul lives (see `settingsHost`'s `AgentDeps`).
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

// A neutral, terminal-agnostic persona so a brand-new user gets a capable agent with no
// setup. `seeded: true` marks it as an untouched default (a terminal detects "personalized"
// by the absence of that flag). Personalization overwrites this file.
const DEFAULT_AGENT_NAME = 'Kodama'

const DEFAULT_SOUL = `---
schema: frieren/agent-soul/v1
agent_name: Kodama
seeded: true
---

You are Kodama, a calm and capable companion. You help with whatever the user is working on — organising files, drafting text, answering questions, and getting things done on their machine. You are concise and clear, proactive without being pushy, and you never pretend to know something you don't. You adapt to how the user likes to work and remember what matters to them over time.
`

// An empty profile — no personal facts until the user chooses to share them.
const DEFAULT_PROFILE = `---
schema: frieren/user-profile/v1
seeded: true
---
`

const encoder = new TextEncoder()
const decoder = new TextDecoder()

// The one reader the RUNTIME needs: what the agent is called. The `settings` capability
// owns WRITING these files (it cannot import this package — the dependency runs the other
// way), but every host that starts a session needs the name for the session title, and
// the seeded default's name is the answer until someone personalizes.
export async function readAgentName(volume: Volume): Promise<string> {
	if (!(await volume.exists(SOUL_PATH))) return DEFAULT_AGENT_NAME
	const text = decoder.decode(await volume.readFile(SOUL_PATH))
	// Frontmatter only: the prose says the name too, and would match first otherwise.
	const match = /^\s*agent_name:\s*(.+?)\s*$/m.exec(text.split('\n---')[0] ?? '')
	return match?.[1] || DEFAULT_AGENT_NAME
}

// Write the default soul + empty profile if they are missing. Idempotent: an existing
// (personalized) file is never overwritten, so returning users keep their persona.
export async function ensureAgentDefaults(volume: Volume): Promise<void> {
	if (!(await volume.exists(PROFILE_PATH))) {
		// After a wipe the whole volume is empty, so `/system` may not exist yet and
		// `writeFile` does not create parents — ensure it before writing the profile.
		await volume.mkdir('/system', { recursive: true })
		await volume.writeFile(PROFILE_PATH, encoder.encode(DEFAULT_PROFILE))
	}
	if (!(await volume.exists(SOUL_PATH))) {
		await volume.mkdir(AGENT_DIR, { recursive: true })
		await volume.writeFile(SOUL_PATH, encoder.encode(DEFAULT_SOUL))
	}
}
