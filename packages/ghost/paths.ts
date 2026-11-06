// The ghost's layout on its Volume: everything of the ghost's under one hidden folder, so a
// person browsing the Volume does not meet it, `rg` skips it, and another agent given the same
// files does not read the persona by accident. What every agent shares, the profile, the
// memory, the daily notes and the skills, sits at `/.ghost`; what is one agent's, its soul,
// avatar, transcripts and shell records, under `/.ghost/agents/<id>/`, `main` being the ghost.
// Every reader imports from here, and the filesystem map in prompts.ts is built from these, so
// the prose and the code cannot drift.

export const GHOST_DIR = '/.ghost'
export const PROFILE = `${GHOST_DIR}/user.md`
export const MEMORY = `${GHOST_DIR}/core.md`
export const DAILY_DIR = `${GHOST_DIR}/daily`
export const SKILLS_DIR = `${GHOST_DIR}/skills`

/** One daily file per day per shell, so every file has one writer. `day` is `YYYY-MM-DD`. */
export const daily = (day: string, shellId: string) => `${DAILY_DIR}/${day}.${shellId}.md`
export const agentDir = (agentId = 'main') => `${GHOST_DIR}/agents/${agentId}`
export const soul = (agentId = 'main') => `${agentDir(agentId)}/soul.md`
export const transcriptsDir = (agentId = 'main') => `${agentDir(agentId)}/transcripts`
export const shellsDir = (agentId = 'main') => `${agentDir(agentId)}/shells`
export const shellTranscripts = (shellId: string, agentId = 'main') =>
	`${transcriptsDir(agentId)}/${shellId}`
/** One transcript file per day per shell, mirrored from its conversation. */
export const transcript = (shellId: string, day: string, agentId = 'main') =>
	`${shellTranscripts(shellId, agentId)}/${day}.jsonl`
export const shellFile = (shellId: string, agentId = 'main') =>
	`${shellsDir(agentId)}/${shellId}.json`
