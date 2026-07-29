// The ONE place that spells the Volume layout the agent depends on. Every reader
// imports from here, and `prompts/filesystem.md` — the block that TELLS the agent this
// layout — is asserted against these constants in paths.test.ts, so the prose and the
// code cannot drift.
//
// Package-internal: it is not re-exported from index.ts. The few paths a host needs are
// the public names in `@justfiles/agent/defaults`.

import { PRIVATE_PREFIXES } from '@justfiles/fs/sync-replica'

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
export const avatar = (agentId = 'main') => `${agentDir(agentId)}/avatar.png`
export const sessionsDir = (agentId = 'main') => `${agentDir(agentId)}/sessions`
export const sessionsMap = (agentId = 'main') => `${sessionsDir(agentId)}/sessions.json`

// Named for when the conversation STARTED, so `ls` is the chronological index: the
// sessions map only ever points at the CURRENT session, so a retired transcript carries
// no metadata but its name.
export const sessionFile = (agentId: string, sessionId: string, at: Date) =>
	`${sessionsDir(agentId)}/${at.toISOString().replace(/[:.]/g, '-').slice(0, 19)}Z-${sessionId}.jsonl`

// Prefixes the agent's shell must never read. ENFORCED in volumeFs, not asked for in the
// prompt — a prompt is not an access-control mechanism. The list is owned by
// @justfiles/fs (which also refuses to replicate them) so the two can't drift; the agent
// shell still needs the deny-list because the agent runs INSIDE the host that holds them.
// `/.state` is excluded: it is the sync engine's own bookkeeping, already listed in the
// prompt as host bookkeeping and harmless to `ls`. What remains is `/private` — private
// in the access-modifier sense: not reachable from outside the host, the agent included.
export const SECRET_PREFIXES = PRIVATE_PREFIXES.filter((p) => p !== '/.state')
