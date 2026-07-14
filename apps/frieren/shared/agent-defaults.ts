import type { Volume } from '@justfiles/fs'

// The two durable identity files the agent reads: the agent's persona (soul) and
// the human's profile. Onboarding used to be mandatory before the desktop would
// open; now these are SEEDED with sensible defaults so the agent works out of the
// box and personalization is opt-in (see PersonalizePanel).
export const SOUL_PATH = '/system/agents/main/soul.md'
export const PROFILE_PATH = '/system/user.md'

// A neutral, working persona so a brand-new user gets a capable agent with no
// setup. Personalization overwrites this file; seeding only fills it when absent.
const DEFAULT_SOUL = `---
schema: frieren/agent-soul/v1
agent_name: Frieren
archetype: assistant
---

You are Frieren, a calm and capable desktop companion. You help with whatever the user is working on — organising files, drafting text, answering questions, and getting things done on their machine. You are concise and clear, proactive without being pushy, and you never pretend to know something you don't. You adapt to how the user likes to work and remember what matters to them over time.
`

// An empty profile — no personal facts until the user chooses to share them.
const DEFAULT_PROFILE = `---
schema: frieren/user-profile/v1
---
`

const encoder = new TextEncoder()

// Write the default soul + empty profile if they are missing. Idempotent: an
// existing (personalized) file is never overwritten, so returning users keep
// their persona. Owned by the server for synced profiles and by the client for
// local-only ones — the same split as built-in app seeding.
export async function ensureAgentDefaults(volume: Volume): Promise<void> {
	if (!(await volume.exists(PROFILE_PATH))) {
		await volume.writeFile(PROFILE_PATH, encoder.encode(DEFAULT_PROFILE))
	}
	if (!(await volume.exists(SOUL_PATH))) {
		await volume.mkdir('/system/agents/main', { recursive: true })
		await volume.writeFile(SOUL_PATH, encoder.encode(DEFAULT_SOUL))
	}
}
