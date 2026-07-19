import type { Volume } from '@justfiles/fs'

// The platform's agent is ONE companion across terminals (web + desktop): these are the
// identity files it reads from the Volume, plus the sensible defaults it seeds so it works
// out of the box with NO onboarding gate — personalization is opt-in and overwrites them.
//
// Deliberately pi-free (only `@justfiles/fs`): `createAssistant` seeds through it, and a
// terminal's *client* can import the paths + seeder for its own pre-seed / personalization
// UI without pulling in the agent runtime. Import from `@justfiles/agent/defaults`.
export const SOUL_PATH = '/system/agents/main/soul.md'
export const AVATAR_PATH = '/system/agents/main/avatar.png'
export const PROFILE_PATH = '/system/user.md'

// A neutral, terminal-agnostic persona so a brand-new user gets a capable agent with no
// setup. `seeded: true` marks it as an untouched default (a terminal detects "personalized"
// by the absence of that flag). Personalization overwrites this file.
const DEFAULT_SOUL = `---
schema: frieren/agent-soul/v1
agent_name: Frieren
archetype: assistant
seeded: true
---

You are Frieren, a calm and capable companion. You help with whatever the user is working on — organising files, drafting text, answering questions, and getting things done on their machine. You are concise and clear, proactive without being pushy, and you never pretend to know something you don't. You adapt to how the user likes to work and remember what matters to them over time.
`

// An empty profile — no personal facts until the user chooses to share them.
const DEFAULT_PROFILE = `---
schema: frieren/user-profile/v1
seeded: true
---
`

const encoder = new TextEncoder()

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
		await volume.mkdir('/system/agents/main', { recursive: true })
		await volume.writeFile(SOUL_PATH, encoder.encode(DEFAULT_SOUL))
	}
}
