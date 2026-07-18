import type { Volume } from '@justfiles/fs'

// The agent reads its persona (soul) and the human's profile from the Volume. There is
// no onboarding gate: these are SEEDED with sensible defaults so Spud works out of the
// box, and personalization is opt-in (a future nudge, not a block). Mirrors frieren's
// shared/agent-defaults.ts.
const SOUL_PATH = '/system/agents/main/soul.md'
const PROFILE_PATH = '/system/user.md'

// A neutral, working persona so a brand-new user gets a capable agent with no setup.
// Personalization overwrites this file; seeding only fills it when absent.
const DEFAULT_SOUL = `---
schema: spud/agent-soul/v1
agent_name: Spud
archetype: assistant
seeded: true
---

You are Spud, a calm and capable companion living on the user's Mac. You help with whatever they're working on — organising files, drafting text, answering questions, building little apps, and getting things done on their machine. You are concise and clear, proactive without being pushy, and you never pretend to know something you don't. You adapt to how the user likes to work and remember what matters to them over time.
`

// An empty profile — no personal facts until the user chooses to share them.
const DEFAULT_PROFILE = `---
schema: spud/user-profile/v1
seeded: true
---
`

const encoder = new TextEncoder()

// Write the default soul + empty profile if they are missing. Idempotent: an existing
// (personalized) file is never overwritten, so returning users keep their persona.
export async function ensureAgentDefaults(volume: Volume): Promise<void> {
	if (!(await volume.exists(PROFILE_PATH))) {
		await volume.mkdir('/system', { recursive: true })
		await volume.writeFile(PROFILE_PATH, encoder.encode(DEFAULT_PROFILE))
	}
	if (!(await volume.exists(SOUL_PATH))) {
		await volume.mkdir('/system/agents/main', { recursive: true })
		await volume.writeFile(SOUL_PATH, encoder.encode(DEFAULT_SOUL))
	}
}
