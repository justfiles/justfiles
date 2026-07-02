import type { SkillMeta } from '@justfiles/agent'

// Slash commands are a DAEMON concept — the agent knows only skills (see agent.ts). The
// daemon owns the registry: its own built-ins plus one entry projected per skill. `kind`
// lets the launcher group/label them; dispatch lives in dispatchCommand (agent.ts).
export interface CommandMeta {
	name: string
	description: string
	kind: 'builtin' | 'skill'
}

// The daemon's built-in commands. `new` clears the session, `debug` dumps agent
// diagnostics — both are host actions the agent has no idea exist.
export const SYSTEM_COMMANDS: readonly CommandMeta[] = [
	{ name: 'new', description: 'Start a fresh chat session', kind: 'builtin' },
	{
		name: 'debug',
		description: 'Show agent diagnostics (system prompt + session state)',
		kind: 'builtin'
	}
]

// The `/` menu: built-ins first, then one entry per skill (a skill whose id shadows a
// built-in name is dropped — the built-in wins). Skills come from the agent's LLM-free
// `listSkills`, so the menu builds without spinning up the assistant.
export function buildCommands(skills: SkillMeta[]): CommandMeta[] {
	const taken = new Set(SYSTEM_COMMANDS.map((command) => command.name))
	return [
		...SYSTEM_COMMANDS,
		...skills
			.filter((skill) => !taken.has(skill.id))
			.map(
				(skill): CommandMeta => ({ name: skill.id, description: skill.description, kind: 'skill' })
			)
	]
}

// What dispatching a command tells the launcher to do. Command output is NOT conversation
// — it never touches the session/transcript:
//   { show: 'chat' }        reveal the chat surface (e.g. `/new`, a skill turn)
//   { show: 'text', body }  render a one-off text panel (e.g. `/debug`)
//   undefined               fire-and-forget — nothing to show (the launcher dismisses)
export type CommandResult = { show: 'chat' } | { show: 'text'; body: string } | undefined
