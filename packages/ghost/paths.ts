// The Volume layout the ghost depends on, copied from packages/agent/paths.ts. Every reader
// imports from here, and the filesystem map in prompts.ts is built from these, so the prose
// and the code cannot drift.

export const NOTES_DIR = '/notes'
export const PROFILE = '/system/user.md'
export const MEMORY = '/system/memory/core.md'
export const DAILY_DIR = '/system/memory/daily'
export const SKILLS_DIR = '/system/skills'
export const CONTEXT_DIR = '/system/context'

/** One daily file per day per shell, so every file has one writer. `day` is `YYYY-MM-DD`. */
export const daily = (day: string, shellId: string) => `${DAILY_DIR}/${day}.${shellId}.md`
export const agentDir = (agentId = 'main') => `/system/agents/${agentId}`
export const soul = (agentId = 'main') => `${agentDir(agentId)}/soul.md`
export const transcriptsDir = (agentId = 'main') => `${agentDir(agentId)}/transcripts`
export const shellsDir = (agentId = 'main') => `${agentDir(agentId)}/shells`
